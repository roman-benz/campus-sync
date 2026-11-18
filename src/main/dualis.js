// Noten aus Dualis (dualis.dhbw.de, CampusNet): Anmeldung mit Benutzername/Kennwort, Leistungsübersicht
// auslesen, lokal zwischenspeichern und im Hintergrund aktualisieren. Neue Noten → Benachrichtigung.
// Die Zugangsdaten liegen verschlüsselt im Geheimnisspeicher (wie das Moodle-Token) und gehen nur an Dualis.
const { EventEmitter } = require('events');
const path = require('path');
const store = require('./store');

const BASE = 'https://dualis.dhbw.de';
const DLL = `${BASE}/scripts/mgrqispi.dll`;
const REFRESH_MS = 3 * 60 * 60 * 1000;
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chadoodle' };

// Protokoll ohne Geheimnisse (kein Kennwort, kein Cookie, Sitzungsnummern gekürzt) – hilft bei Problemen
const LOG_FILE = () => store.file(path.join('logs', 'dualis.log'));
const mask = (s) => String(s).replace(/-N\d{9,}/g, '-N…').replace(/(usrname|pass)=[^&]*/gi, '$1=…');
function log(msg) {
  try {
    const fs = require('fs');
    const f = LOG_FILE();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (fs.existsSync(f) && fs.statSync(f).size > 256 * 1024) fs.renameSync(f, f + '.old');
    fs.appendFileSync(f, `${new Date().toISOString()} ${mask(msg)}\n`);
  } catch {}
}
const prg = (url) => (/PRGNAME=([A-Z_]+)/i.exec(url || '') || [])[1] || url;
const pageInfo = (page) => {
  const h = text((/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(page) || [])[1] || '') || text((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(page) || [])[1] || '');
  return `${page.length} Zeichen, Überschrift „${h.slice(0, 80)}“, Tabellen: ${(page.match(/<table/gi) || []).length}, Leistungsübersicht: ${/students_results/.test(page) ? 'ja' : 'nein'}, Timeout-Hinweis: ${/Timeout|erneut an/i.test(page) ? 'ja' : 'nein'}`;
};

class DualisError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

// ---------- HTML-Auswertung (ohne DOM, damit es überall läuft) ----------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß' };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e] ?? m,
  );
const text = (h) =>
  decode(String(h || '').replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
const num = (s) => {
  const n = parseFloat(String(s || '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

function cells(rowHtml) {
  const out = [];
  rowHtml.replace(/<t([dh])\b([^>]*)>([\s\S]*?)<\/t\1>/gi, (_m, _t, attrs, inner) => {
    out.push({
      cls: (/class="([^"]*)"/i.exec(attrs) || [])[1] || '',
      text: text(inner),
      img: decode((/<img[^>]*\btitle="([^"]*)"/i.exec(inner) || /<img[^>]*\balt="([^"]*)"/i.exec(inner) || [])[1] || ''),
    });
    return '';
  });
  return out;
}

function tables(html, cls) {
  const re = new RegExp(`<table[^>]*class="[^"]*${cls}[^"]*"[^>]*>([\\s\\S]*?)</table>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(html))) out.push([...m[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => cells(r[1])));
  return out;
}

// Leistungsübersicht (PRGNAME=STUDENT_RESULT) → Gruppen mit Modulen, Summen, GPA
function parseResults(html) {
  const [main = [], gpaRows = []] = tables(html, 'students_results');
  if (!main.length) throw new DualisError('Die Leistungsübersicht von Dualis hat ein unbekanntes Format.', 'format');
  const groups = [];
  let heading = null;
  let program = '';
  let total = null;
  let required = null;
  for (const c of main) {
    if (!c.length || c.some((x) => /tbsubhead/.test(x.cls))) continue;
    const first = c[0];
    if (/tbdata/.test(first.cls) && c.length >= 6) {
      if (!heading || heading.used === false) {
        heading = { title: heading ? heading.title : 'Module', modules: [], sum: null, used: true };
        groups.push(heading);
      }
      heading.modules.push({
        no: first.text,
        name: c[1].text,
        date: c[2].text || null,
        credits: num(c[3].text),
        grade: c[4].text || null,
        status: c[5].img || c[5].text || '',
      });
      continue;
    }
    if (/^level/.test(first.cls)) {
      const label = first.text;
      if (/^Erforderliche Credits/i.test(label)) {
        // Die Zahl steht je nach Dualis-Version in einer eigenen Zelle oder hinter der Beschriftung
        const nums = c.map((x) => x.text).join(' ').match(/\d+(?:,\d+)?/g);
        required = nums ? num(nums[nums.length - 1]) : null;
        continue;
      }
      const sum = { label, credits: num(c[2] && c[2].text), grade: (c[3] && c[3].text) || null, status: (c[4] && (c[4].img || c[4].text)) || '' };
      const g = groups.find((x) => `Summe ${x.title}` === label);
      if (g) g.sum = sum;
      if (/level00/.test(first.cls) && /^Summe /.test(label)) total = sum;
      continue;
    }
    // Überschrift (Studiengang, Bereich, Modulgruppe)
    if (first.text && c.slice(1).every((x) => !x.text && !x.img)) {
      if (!program) program = first.text;
      heading = { title: first.text, modules: [], sum: null, used: false };
    }
  }
  const gpa = {};
  for (const c of gpaRows) {
    if (c.length >= 2 && /GPA/i.test(c[0].text)) gpa[/hauptfach/i.test(c[0].text) ? 'major' : 'total'] = c[1].text || null;
  }
  return { program, groups: groups.filter((g) => g.modules.length).map(({ used, ...g }) => g), total, required, gpa };
}

// ---------- Dienst ----------
class Dualis extends EventEmitter {
  constructor() {
    super();
    this.busy = null;
    this.error = null;
    this.cache = store.readJson(this.cachePath(), null);
  }

  cachePath() {
    return store.file(path.join('cache', 'dualis.json'));
  }

  configured() {
    return !!(store.getSecret('dualisUser') && store.getSecret('dualisPass'));
  }

  status() {
    return {
      configured: this.configured(),
      user: store.getSecret('dualisUser'),
      busy: !!this.busy,
      error: this.error,
      errorCode: this.errorCode || null,
      fetchedAt: this.cache ? this.cache.fetchedAt : null,
      data: this.cache ? this.cache.data : null,
    };
  }

  async request(url, opts = {}, cookie = '') {
    const res = await fetch(url, { redirect: 'follow', ...opts, signal: AbortSignal.timeout(30000), headers: { ...UA, ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) } });
    if (res.status >= 500) throw new DualisError(`Dualis antwortet nicht (HTTP ${res.status}).`, 'http');
    return res;
  }

  async login(user, pass) {
    const body = new URLSearchParams({
      usrname: user,
      pass,
      APPNAME: 'CampusNet',
      PRGNAME: 'LOGINCHECK',
      ARGUMENTS: 'clino,usrname,pass,menuno,menu_type,browser,platform',
      clino: '000000000000001',
      menuno: '000324',
      menu_type: 'classic',
      browser: '',
      platform: '',
    });
    const res = await this.request(DLL, { method: 'POST', body, redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const refresh = res.headers.get('refresh') || '';
    const session = (/ARGUMENTS=-N(\d+)/.exec(refresh) || [])[1];
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    // Wie ein Browser: „cnsc =wert“ → „cnsc=wert“ (Name und Wert ohne Leerzeichen)
    const cookie = setCookies
      .map((c) => c.split(';')[0])
      .map((c) => {
        const i = c.indexOf('=');
        return i > 0 ? `${c.slice(0, i).trim()}=${c.slice(i + 1).trim()}` : '';
      })
      .filter(Boolean)
      .join('; ');
    log(`Anmeldung: HTTP ${res.status}, Weiterleitung ${refresh ? prg(refresh) : 'keine'}, Cookies: ${setCookies.map((c) => c.split('=')[0].trim()).join(', ') || 'keine'}`);
    if (!session || /^0+1?$/.test(session)) {
      const page = await res.text().catch(() => '');
      log(`Anmeldung abgelehnt: HTTP ${res.status}, ${pageInfo(page)}, Anmeldeformular: ${/type="password"/i.test(page) ? 'ja' : 'nein'}`);
      // Nur ein erneut gezeigtes Anmeldeformular heißt „Zugangsdaten falsch“ – sonst ist Dualis gestört
      if (!/type="password"/i.test(page)) throw new DualisError('Dualis hat unerwartet geantwortet – bitte später erneut versuchen.', 'unexpected');
      throw new DualisError('Anmeldung bei Dualis fehlgeschlagen – Benutzername oder Kennwort falsch.', 'auth');
    }
    return { session, cookie, start: new URL(refresh.replace(/^.*?URL=/i, '').trim(), BASE).href };
  }

  async logoutSession(s) {
    await this.request(`${DLL}?APPNAME=CampusNet&PRGNAME=LOGOUT&ARGUMENTS=-N${s.session},-N001`, {}, s.cookie).catch(() => {});
  }

  // Adresse der Leistungsübersicht aus dem Menü der Startseite (Fallback: bekannte Adresse)
  async resultsUrl(s) {
    let url = s.start;
    for (let hop = 0; hop < 3 && url; hop++) {
      const res = await this.request(url, {}, s.cookie);
      const page = await res.text();
      log(`Startseite ${hop + 1} (${prg(url)}): HTTP ${res.status}, ${pageInfo(page)}`);
      const link = /href="([^"]*PRGNAME=STUDENT_RESULT[^"]*)"/i.exec(page);
      if (link) return new URL(decode(link[1]), BASE).href;
      const next = (/URL=([^"'\s>]+)/i.exec(res.headers.get('refresh') || '') || /http-equiv="refresh"[^>]*content="[^"]*URL=([^"]+)"/i.exec(page) || [])[1];
      url = next ? new URL(decode(next), BASE).href : null;
    }
    log('Kein Menülink zur Leistungsübersicht gefunden – nutze die Standardadresse');
    return `${DLL}?APPNAME=CampusNet&PRGNAME=STUDENT_RESULT&ARGUMENTS=-N${s.session},-N000310,-N0,-N000000000000000,-N000000000000000,-N000000000000000,-N0,-N000000000000000`;
  }

  async fetchResults(user, pass) {
    const s = await this.login(user, pass);
    try {
      const url = await this.resultsUrl(s);
      const res = await this.request(url, {}, s.cookie);
      const page = await res.text();
      log(`Leistungsübersicht (${prg(url)}): HTTP ${res.status}, ${pageInfo(page)}`);
      return parseResults(page);
    } finally {
      await this.logoutSession(s);
    }
  }

  // Zugangsdaten prüfen, speichern und Noten laden
  async setCredentials(user, pass) {
    user = String(user || '').trim();
    pass = String(pass || '');
    if (!user || !pass) throw new DualisError('Bitte Benutzername und Kennwort eingeben.', 'input');
    const data = await this.fetchResults(user, pass);
    store.setSecret('dualisUser', user);
    store.setSecret('dualisPass', pass);
    this.save(data, { notify: false });
    return this.status();
  }

  removeCredentials() {
    store.setSecret('dualisUser', null);
    store.setSecret('dualisPass', null);
    this.cache = null;
    this.error = null;
    this.errorCode = null;
    try {
      require('fs').rmSync(this.cachePath(), { force: true });
    } catch {}
    this.emit('changed');
    return this.status();
  }

  save(data, { notify = true } = {}) {
    const prev = this.cache && this.cache.data;
    const before = new Map(prev ? prev.groups.flatMap((g) => g.modules).map((m) => [m.no, m]) : []);
    const fresh = [];
    for (const m of data.groups.flatMap((g) => g.modules)) {
      const old = before.get(m.no);
      // „Neu“-Markierung (7 Tage in der Ansicht): Note ist seit dem letzten Abruf dazugekommen
      if (old && old.newAt && old.grade === m.grade) m.newAt = old.newAt;
      else if (prev && m.grade && !(old && old.grade)) {
        m.newAt = Date.now();
        fresh.push(m);
      }
    }
    this.cache = { fetchedAt: Date.now(), data };
    this.error = null;
    this.errorCode = null;
    this.authNotified = false;
    store.writeJson(this.cachePath(), this.cache);
    if (notify && fresh.length) {
      const fmt = (n) => String(n).replace('.', ',');
      const line = (m) => [m.grade && `Note ${m.grade}`, m.credits && `${fmt(m.credits)} Credits`, m.status].filter(Boolean).join(' · ');
      if (fresh.length === 1) {
        this.emit('notify', { title: `🎓 Neue Note: ${fresh[0].name}`, body: `${line(fresh[0])}\nDualis · ${fresh[0].no}` });
      } else {
        const list = fresh.map((m) => `${m.name}: ${m.grade}`);
        this.emit('notify', { title: `🎓 ${fresh.length} neue Noten in Dualis`, body: `${list.slice(0, 3).join(' · ')}${list.length > 3 ? ` · und ${list.length - 3} weitere` : ''}` });
      }
    }
    this.emit('changed');
  }

  refresh() {
    if (this.busy) return this.busy;
    if (!this.configured()) return Promise.resolve(this.status());
    this.busy = (async () => {
      this.emit('changed');
      try {
        this.save(await this.fetchResults(store.getSecret('dualisUser'), store.getSecret('dualisPass')));
      } catch (e) {
        log(`Aktualisierung fehlgeschlagen: ${e.code || ''} ${e.message}`);
        if (e.code === 'auth') {
          // Kennwort geändert o. Ä.: einmal deutlich melden, die Ansicht bietet die Neuanmeldung an
          this.error = 'Dualis hat das gespeicherte Kennwort abgelehnt. Bitte im Reiter Noten neu anmelden.';
          this.errorCode = 'auth';
          if (!this.authNotified) {
            this.authNotified = true;
            this.emit('notify', { title: 'Dualis-Anmeldung abgelaufen', body: 'Das gespeicherte Kennwort wurde abgelehnt (geändert?).\nBitte in Chadoodle unter „Noten“ neu anmelden.', button: 'Neu anmelden' });
          }
        } else {
          this.error = e.name === 'TimeoutError' || /fetch failed/.test(e.message) ? 'Dualis ist gerade nicht erreichbar.' : e.message;
          this.errorCode = e.code || 'error';
        }
      } finally {
        this.busy = null;
        this.emit('changed');
      }
      return this.status();
    })();
    return this.busy;
  }

  start() {
    setTimeout(() => this.refresh(), 60 * 1000);
    setInterval(() => this.refresh(), REFRESH_MS);
  }
}

module.exports = { Dualis, DualisError, parseResults, LOG_FILE };
