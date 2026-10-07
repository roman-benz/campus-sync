// Speiseplan aus my-mensa.de (z. B. Mensa Fallenbrunnen). Die Seite „mensatogo.php“ lädt ihre
// Daten aus getdata.php als JSON – genau diese Quelle wird hier gelesen, bereinigt und lokal
// zwischengespeichert, damit der letzte Stand auch offline sichtbar bleibt.
const { EventEmitter } = require('events');
const path = require('path');
const store = require('./store');

const DEFAULT_URL = 'https://zuf.my-mensa.de/mensatogo.php?mensa=mensa_fallenbrunnen';
const STALE_MS = 30 * 60 * 1000;
const CACHE_VERSION = 3; // v2: Artikel-ID (a_id) für Bestellungen, v3: Windows-1252-Zeichen repariert
const CONFIG_TTL = 10 * 60 * 1000;
const REFRESH_MS = 3 * 60 * 60 * 1000;
// Wie jQuery.ajax auf der Bestellseite
const FORM_HEADERS = { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Accept: 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' };
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
const CP1252 = ['€', '', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '', 'Ž', '', '', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '', 'ž', 'Ÿ'];
function clean(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return e.toLowerCase() in ENTITIES ? ENTITIES[e.toLowerCase()] : m;
    })
    .replace(/­/g, '')
    // Steuerzeichen U+0080–U+009F sind falsch kodierte Windows-1252-Zeichen (z. B. 0x96 = „–“)
    .replace(/[\u0080-\u009f]/g, (ch) => CP1252[ch.charCodeAt(0) - 0x80] || '')
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
          aid: e.a_id ? String(e.a_id) : null,
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
    if (!force && c && c.v === CACHE_VERSION && c.url === this.url() && Date.now() - c.fetchedAt < STALE_MS) return c;
    try {
      return await this.fetch();
    } catch (e) {
      if (c && c.url === this.url()) return { ...c, error: e.message };
      throw e;
    }
  }

  // Rohdaten aus getdata.php (für Bestellungen werden die Originaltexte und -preise gebraucht)
  async raw() {
    const { origin, mensaId } = parseMensaUrl(this.url());
    const api = `${origin}/getdata.php?mensa_id=${encodeURIComponent(mensaId)}&json=1&hyp=1&now=${Date.now()}&mode=togo&lang=de`;
    const res = await fetch(api, { signal: AbortSignal.timeout(20000), headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Speiseplan nicht erreichbar (HTTP ${res.status})`);
    try {
      return await res.json();
    } catch {
      throw new Error('Unter diesem Link liegt kein Speiseplan.');
    }
  }

  async fetch() {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const url = this.url();
      const { origin } = parseMensaUrl(url);
      const json = await this.raw();
      const data = { ...normalize(json, origin), v: CACHE_VERSION, url, fetchedAt: Date.now() };
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

  // ---------- Bestellen ----------
  // Die Bestellseite (mensatogo.php) bringt API-Adresse und Mensa-Konfiguration im Quelltext mit
  async orderConfig() {
    const url = this.url();
    if (this.cfg && this.cfg.url === url && Date.now() - this.cfg.at < CONFIG_TTL) return this.cfg;
    const { origin, mensaId } = parseMensaUrl(url);
    const res = await fetch(`${origin}/mensatogo.php?mensa=${encodeURIComponent(mensaId)}`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`Bestellseite nicht erreichbar (HTTP ${res.status})`);
    const html = await res.text();
    const api = /var\s+apiLink\s*=\s*'([^']+)'/.exec(html);
    const conf = /var\s+mensen\s*=\s*JSON\.parse\('(.*?)'\);/.exec(html);
    if (!api || !conf) throw new Error('Bei dieser Mensa ist keine Vorbestellung möglich.');
    let all;
    try {
      all = JSON.parse(conf[1].replace(/\\'/g, "'"));
    } catch {
      throw new Error('Die Bestellseite konnte nicht gelesen werden.');
    }
    const config = all[mensaId];
    if (!config || !config.mmplus_location_id) throw new Error('Bei dieser Mensa ist keine Vorbestellung möglich.');
    this.cfg = { url, at: Date.now(), origin, mensaId, api: api[1], config };
    return this.cfg;
  }

  async apiPost(cfg, endpoint, params) {
    const res = await fetch(`${cfg.api}api/${endpoint}/`, {
      method: 'POST',
      signal: AbortSignal.timeout(20000),
      headers: FORM_HEADERS,
      body: new URLSearchParams(params).toString(),
    });
    if (!res.ok) throw new Error(`Der Mensa-Server antwortet nicht (HTTP ${res.status}).`);
    return res.json();
  }

  // Frühester bestellbarer Tag wie auf der Bestellseite: maxBookingTimes bildet den Wochentag
  // (1 = Mo … 7 = So) vor bzw. nach bookingSplitTime auf den ersten erlaubten Wochentag ab
  earliestDate(config, now = new Date()) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' })
        .formatToParts(now)
        .map((p) => [p.type, p.value]),
    );
    const wd = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday) + 1;
    const split = String(config.bookingSplitTime || '09:00').slice(0, 5).padStart(5, '0');
    const map = (config.maxBookingTimes || {})[`${parts.hour}:${parts.minute}` < split ? 'vormittag' : 'nachmittag'] || {};
    const offset = (Number(map[wd] || (wd % 7) + 1) - wd + 7) % 7;
    const d = new Date(`${parts.year}-${parts.month}-${parts.day}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  }

  // Abholzeiten und Restmengen für einen Tag
  async orderOptions(date, email) {
    const cfg = await this.orderConfig();
    const c = cfg.config;
    const earliest = this.earliestDate(c);
    const out = { date, earliest, orderable: date >= earliest, termsUrl: c.nutzungs_vereinbarung_link || '', minOrder: Number(c.mindest_bestell_wert) || 0, slots: [], message: '', stock: {} };
    if (!out.orderable) return out;
    const [slots, stock] = await Promise.all([
      this.apiPost(cfg, 'get_free_slots', { mensa_id: c.mmplus_location_id, tag: date, id: email || '' }),
      c.checkContigent ? this.apiPost(cfg, 'get_contigent', {}).catch(() => ({})) : {},
    ]);
    if (slots && typeof slots === 'object' && 'message' in slots) out.message = clean(slots.message);
    else {
      // „HH:MM:SS“ → freie Plätze; der letzte Eintrag (-1) markiert nur das Ende des letzten Fensters
      const keys = Object.keys(slots || {}).sort();
      out.slots = keys.slice(0, -1).map((k, i) => ({ time: k.slice(0, 5), until: keys[i + 1].slice(0, 5), free: Number(slots[k]) }));
    }
    for (const [aid, x] of Object.entries(stock || {})) out.stock[aid] = { rest: Number(x.rest), live: Number(x.restlive) };
    return out;
  }

  // Bestellung absenden – Felder genau wie das jQuery-Formular der offiziellen Seite
  async order({ date, items, time, firstName, lastName, email }) {
    firstName = String(firstName || '').trim();
    lastName = String(lastName || '').trim();
    email = String(email || '').trim();
    if (!firstName || !lastName) throw new Error('Bitte Vor- und Nachname angeben.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Bitte eine gültige E-Mail-Adresse angeben.');
    if (!/^\d{2}:\d{2}$/.test(String(time || ''))) throw new Error('Bitte eine Abholzeit wählen.');
    const wanted = Object.entries(items || {}).map(([aid, n]) => [String(aid), Math.floor(Number(n))]).filter(([, n]) => n > 0);
    if (!wanted.length) throw new Error('Der Warenkorb ist leer.');
    if (wanted.some(([, n]) => n > 20)) throw new Error('Höchstens 20 Stück pro Gericht.');

    const cfg = await this.orderConfig();
    const opts = await this.orderOptions(date, email);
    if (!opts.orderable) throw new Error('Für diesen Tag kann nicht mehr bestellt werden.');
    const slot = opts.slots.find((x) => x.time === time);
    if (!slot || slot.free <= 0) throw new Error('Diese Abholzeit ist nicht mehr frei.');

    const json = await this.raw();
    const day = (json.result || []).find((d) => d.tag && d.tag.datum_iso === date);
    if (!day) throw new Error('Für diesen Tag gibt es keinen Speiseplan.');
    const byId = new Map((day.essen || []).map((e) => [String(e.a_id), e]));
    for (const [aid, n] of wanted) {
      const e = byId.get(aid);
      if (!e) throw new Error('Ein Gericht im Warenkorb gibt es nicht mehr.');
      const s = opts.stock[aid];
      if (Object.keys(opts.stock).length && !s) throw new Error(`${clean(e.title_clean || e.title)} kann nicht vorbestellt werden.`);
      if (s && (s.rest <= 0 || s.live < n)) throw new Error(`${clean(e.title_clean || e.title)}: nur noch ${Math.max(0, s.live)} verfügbar.`);
    }

    // basket_html ist das innerHTML der Warenkorb-Tabelle (&shy; als Zeichen, &nbsp; bleibt Entity)
    const shy = (t) => String(t || '').replace(/&shy;/g, '­');
    const priceHtml = (e) => String(e.preis_formated_Togo || '').replace(/&euro;/g, '€').replace(/<br\s*\/?>/gi, '<br>');
    const rows = wanted.map(([aid, n]) => `<tr><td>${n}x</td> <td aid_check="${aid}">${shy(byId.get(aid).title)}</td> <td class="preis">${priceHtml(byId.get(aid))}</td></tr>`);
    const basketHtml = `<tbody><tr><th>Anzahl</th> <th>Artikel</th> <th class="zahl">Stückpreis</th></tr> ${rows.join(' ')} <tr class="trenner"><td></td> <td></td> <td></td></tr></tbody>`;

    const client = {
      einrichtung: clean(json.mensaname) || cfg.mensaId,
      einrichtung_val: cfg.mensaId,
      vorname: firstName,
      name: lastName,
      email,
      nv2: 'on',
      save_allowed: 'on',
      language_val: 'de',
      language: '',
      deliver_time_val: time,
      date_iso: date,
      date_hr: day.tag.tag_formatiert2 || date,
    };
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(client)) p.append(`client[${k}]`, v);
    for (const [aid, n] of wanted) p.append(`basket_positions[${aid}]`, String(n));
    p.append('basket_html', basketHtml);
    for (const [aid, n] of wanted) {
      const e = byId.get(aid);
      const full = { id: e.a_id, category: e.category, title: `${e.title} ${e.description} ${e.kennzRest || ''}`, preis1: e.preis1, preis2: e.preis2, preis3: e.preis3, preis5: e.preis5, anzahl: n };
      for (const [k, v] of Object.entries(full)) p.append(`basket_full[${aid}][${k}]`, String(v ?? ''));
    }

    const res = await fetch(`${cfg.origin}/setDataMensaTogo.php?order=add&language=de`, { method: 'POST', signal: AbortSignal.timeout(30000), headers: FORM_HEADERS, body: p.toString() });
    if (!res.ok) throw new Error(`Bestellung fehlgeschlagen (HTTP ${res.status}).`);
    let r;
    try {
      r = await res.json();
    } catch {
      throw new Error('Unerwartete Antwort der Mensa – bitte erst im E-Mail-Postfach nachsehen, bevor du nochmal bestellst.');
    }
    if (!r || r.type !== 'success') throw new Error(clean((r && r.text) || 'Die Bestellung wurde abgelehnt.'));

    const entry = {
      no: clean(r.text),
      date,
      time,
      until: slot.until,
      email,
      mensa: client.einrichtung,
      items: wanted.map(([aid, n]) => ({ aid, n, title: clean(byId.get(aid).title_clean || byId.get(aid).title), dhbw: price(byId.get(aid).preis2) })),
      at: Date.now(),
    };
    store.writeJson(this.ordersPath(), [entry, ...this.orders()].slice(0, 200));
    return entry;
  }

  ordersPath() {
    return store.file('mensa-orders.json');
  }

  // Lokal gemerkte Bestellungen (nur die, die über Chadoodle aufgegeben wurden)
  orders() {
    const l = store.readJson(this.ordersPath(), []);
    return Array.isArray(l) ? l : [];
  }

  start() {
    setTimeout(() => this.fetch().catch(() => {}), 15 * 1000);
    setInterval(() => this.fetch().catch(() => {}), REFRESH_MS);
  }
}

module.exports = { Mensa, parseMensaUrl, normalize, DEFAULT_URL };
