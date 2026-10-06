// Speiseplan aus my-mensa.de (z. B. Mensa Fallenbrunnen). Die Seite „mensatogo.php“ lädt ihre
// Daten aus getdata.php als JSON – genau diese Quelle wird hier gelesen, bereinigt und lokal
// zwischengespeichert, damit der letzte Stand auch offline sichtbar bleibt.
const { EventEmitter } = require('events');
const path = require('path');
const store = require('./store');

const DEFAULT_URL = 'https://zuf.my-mensa.de/mensatogo.php?mensa=mensa_fallenbrunnen';
const STALE_MS = 30 * 60 * 1000;
const REFRESH_MS = 3 * 60 * 60 * 1000;
// Ernährungsform zuerst (als Badge), der Rest sind Allergene/Zusatzstoffe
const DIET = { VEG: 'vegan', V: 'vegetarisch', F: 'Fisch', G: 'Geflügel', R: 'Rind', S: 'Schwein', L: 'Lamm', W: 'Wild' };

// Link → { origin, mensaId }. Akzeptiert die Mensa-Seite oder direkt getdata.php
function parseMensaUrl(input) {
  let u;
  try {
    u = new URL(String(input || '').trim());
  } catch {
    throw new Error('Das ist kein gültiger Link.');
  }
  if (!/^https?:$/.test(u.protocol) || !/(^|\.)my-mensa\.de$/i.test(u.hostname)) throw new Error('Bitte einen Link von my-mensa.de angeben.');
  const mensaId = u.searchParams.get('mensa') || u.searchParams.get('mensa_id');
  if (!mensaId) throw new Error('Im Link fehlt die Mensa (…?mensa=…).');
  return { origin: u.origin, mensaId };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '', euro: '€' };
function clean(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return e.toLowerCase() in ENTITIES ? ENTITIES[e.toLowerCase()] : m;
    })
    .replace(/­/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const price = (v) => {
  const n = parseFloat(String(v || '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
};

function normalize(json, origin) {
  const abs = (p) => (p ? new URL(String(p).replace(/^\.\//, ''), origin + '/').toString() : null);
  const days = (json.result || []).map((d) => {
    const t = d.tag || {};
    return {
      date: t.datum_iso,
      weekday: t.wochentag || '',
      label: clean(t.tag_formatiert2 || t.datum_iso),
      rel: clean(t.tag_formatiert_rel || ''),
      dishes: (d.essen || []).map((e) => {
        const codes = String(e.kennzeichnungen || '').split(',').map((x) => x.trim()).filter(Boolean);
        const legend = e.icons2 && typeof e.icons2 === 'object' ? e.icons2 : {};
        const tags = codes.map((code) => ({
          code,
          text: clean((legend[code] && legend[code].text) || DIET[code] || code),
          diet: code in DIET,
        }));
        return {
          id: String(e.md5 || e.a_id || `${t.datum_iso}-${e.title}`),
          category: clean(e.category),
          title: clean(e.title_clean || e.title),
          description: clean(e.description_clean || e.description),
          prices: { intern: price(e.preis1), dhbw: price(e.preis2), extern: price(e.preis3) },
          unit: clean(e.einheit),
          image: e.foto ? abs(e.foto_sized || e.foto) : null,
          thumb: e.foto ? abs(e.foto_thumb || e.foto_sized || e.foto) : null,
          tags,
        };
      }),
    };
  });
  return { name: clean(json.mensaname) || 'Mensa', days };
}

class Mensa extends EventEmitter {
  constructor() {
    super();
    this.loading = null;
  }

  url() {
    return store.getSettings().mensaUrl || DEFAULT_URL;
  }

  cachePath() {
    return store.file(path.join('cache', 'mensa.json'));
  }

  cached() {
    return store.readJson(this.cachePath(), null);
  }

  // Aktueller Stand; lädt neu, wenn er älter als 30 Minuten ist (oder force)
  async get(force = false) {
    const c = this.cached();
    if (!force && c && c.url === this.url() && Date.now() - c.fetchedAt < STALE_MS) return c;
    try {
      return await this.fetch();
    } catch (e) {
      if (c && c.url === this.url()) return { ...c, error: e.message };
      throw e;
    }
  }

  async fetch() {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const url = this.url();
      const { origin, mensaId } = parseMensaUrl(url);
      const api = `${origin}/getdata.php?mensa_id=${encodeURIComponent(mensaId)}&json=1&hyp=1&now=${Date.now()}&mode=togo&lang=de`;
      const res = await fetch(api, { signal: AbortSignal.timeout(20000), headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`Speiseplan nicht erreichbar (HTTP ${res.status})`);
      let json;
      try {
        json = await res.json();
      } catch {
        throw new Error('Unter diesem Link liegt kein Speiseplan.');
      }
      const data = { ...normalize(json, origin), url, fetchedAt: Date.now() };
      store.writeJson(this.cachePath(), data);
      this.emit('changed');
      return data;
    })();
    try {
      return await this.loading;
    } finally {
      this.loading = null;
    }
  }

  // Neuen Link erst prüfen (laden), dann speichern
  async setUrl(url) {
    parseMensaUrl(url);
    const prev = store.getSettings().mensaUrl;
    store.setSettings({ mensaUrl: String(url).trim() });
    try {
      return await this.fetch();
    } catch (e) {
      store.setSettings({ mensaUrl: prev || '' });
      throw e;
    }
  }

  start() {
    setTimeout(() => this.fetch().catch(() => {}), 15 * 1000);
    setInterval(() => this.fetch().catch(() => {}), REFRESH_MS);
  }
}

module.exports = { Mensa, parseMensaUrl, normalize, DEFAULT_URL };
