// Stundenpläne aus iCal-Quellen (Rapla der DHBW oder beliebige .ics/webcal-Links).
// Jeder Plan wird geladen, in einzelne Termine aufgelöst und lokal zwischengespeichert,
// damit die Ansicht auch offline funktioniert.
const { EventEmitter } = require('events');
const crypto = require('crypto');
const path = require('path');
const store = require('./store');

const RAPLA_TEMPLATE = {
  name: 'TSA25 · DHBW Ravensburg',
  url: 'https://rapla.dhbw.de/rapla/internal_calendar?user=muenzer@vw.ba.ba-ravensburg.de&file=TSA25',
};
const REFRESH_MS = 2 * 60 * 60 * 1000;
const WINDOW_PAST_DAYS = 120;
const WINDOW_FUTURE_DAYS = 400;

// Rapla-Ansichtslinks (internal_calendar, calendar) auf den iCal-Export umbiegen, webcal → https
function icalUrl(input) {
  let u;
  try {
    u = new URL(String(input || '').trim().replace(/^webcals?:\/\//i, 'https://'));
  } catch {
    throw new Error('Das ist kein gültiger Link.');
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Nur http(s)- oder webcal-Links werden unterstützt.');
  if (/(^|\.)rapla\./i.test(u.hostname) && /\/rapla\/(internal_calendar|calendar)$/i.test(u.pathname)) {
    const q = new URLSearchParams();
    for (const k of ['user', 'file', 'key', 'salt']) if (u.searchParams.get(k)) q.set(k, u.searchParams.get(k));
    return `${u.origin}/rapla/ical?${q}`;
  }
  return u.toString();
}

// ---------- iCal-Parser (RFC 5545, was Stundenpläne tatsächlich nutzen) ----------
function unfold(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}
const unescapeText = (s) => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

function parseLine(line) {
  const i = line.indexOf(':');
  if (i < 0) return null;
  const [name, ...params] = line.slice(0, i).split(';');
  const p = {};
  for (const x of params) {
    const [k, v] = x.split('=');
    if (k) p[k.toUpperCase()] = (v || '').replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params: p, value: line.slice(i + 1) };
}

// Zeitzonen-Versatz einer IANA-Zone zu einem UTC-Zeitpunkt (in ms)
const fmtCache = new Map();
function tzOffset(utcMs, tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    fmtCache.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
}

// Wanduhrzeit in einer Zone → UTC (berücksichtigt Sommer-/Winterzeit)
function zonedToUtc(w, tz) {
  const guess = Date.UTC(w.y, w.mo, w.d, w.h, w.mi, w.s);
  if (!tz) return guess;
  let t;
  try {
    t = guess - tzOffset(guess, tz);
    return guess - tzOffset(t, tz);
  } catch {
    return guess; // unbekannte Zone: als UTC behandeln
  }
}

// DATE / DATE-TIME → { wall, tz, utc, allDay }
function parseDate(prop) {
  if (!prop) return null;
  const v = prop.value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v);
  if (!m) return null;
  const wall = { y: +m[1], mo: +m[2] - 1, d: +m[3], h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0) };
  const allDay = prop.params.VALUE === 'DATE' || !m[4];
  const tz = m[7] ? null : allDay ? 'Europe/Berlin' : prop.params.TZID || 'Europe/Berlin';
  return { wall, tz, allDay, utc: m[7] ? Date.UTC(wall.y, wall.mo, wall.d, wall.h, wall.mi, wall.s) : zonedToUtc(wall, tz) };
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const wallKey = (w) => `${w.y}-${w.mo}-${w.d}-${w.h}-${w.mi}`;
function addDays(w, n) {
  const t = new Date(Date.UTC(w.y, w.mo, w.d + n));
  return { ...w, y: t.getUTCFullYear(), mo: t.getUTCMonth(), d: t.getUTCDate() };
}
const weekday = (w) => new Date(Date.UTC(w.y, w.mo, w.d)).getUTCDay();

// Wiederholungen auflösen: täglich/wöchentlich/monatlich mit COUNT, UNTIL, INTERVAL, BYDAY
function expand(start, rrule, exdates, limitUtc) {
  const r = Object.fromEntries(rrule.split(';').map((x) => x.split('=')));
  const freq = r.FREQ;
  const interval = Math.max(1, +r.INTERVAL || 1);
  const count = r.COUNT ? +r.COUNT : Infinity;
  const until = r.UNTIL ? parseDate({ value: r.UNTIL, params: {} }).utc : Infinity;
  const toUtc = (w) => (start.tz ? zonedToUtc(w, start.tz) : Date.UTC(w.y, w.mo, w.d, w.h, w.mi, w.s));
  const out = [];
  let n = 0;
  const push = (w) => {
    const utc = toUtc(w);
    if (utc < start.utc) return true;
    if (utc > until || n >= count || utc > limitUtc) return false;
    n++;
    if (!exdates.has(wallKey(w))) out.push(utc);
    return true;
  };
  if (freq === 'WEEKLY') {
    const by = r.BYDAY ? r.BYDAY.split(',').map((d) => DAYS.indexOf(d.slice(-2))).filter((d) => d >= 0) : [weekday(start.wall)];
    const monday = addDays(start.wall, -((weekday(start.wall) + 6) % 7));
    for (let wk = 0; wk < 600; wk += interval) {
      const days = by.map((d) => addDays(monday, wk * 7 + ((d + 6) % 7))).sort((a, b) => toUtc(a) - toUtc(b));
      for (const w of days) if (!push(w)) return out;
    }
  } else if (freq === 'DAILY') {
    for (let i = 0; i < 3000; i += interval) if (!push(addDays(start.wall, i))) return out;
  } else if (freq === 'MONTHLY') {
    for (let i = 0; i < 240; i += interval) {
      const t = new Date(Date.UTC(start.wall.y, start.wall.mo + i, start.wall.d));
      if (t.getUTCDate() !== start.wall.d) continue; // z. B. 31. in kurzen Monaten
      if (!push({ ...start.wall, y: t.getUTCFullYear(), mo: t.getUTCMonth() })) return out;
    }
  } else {
    out.push(start.utc); // unbekannte Regel: nur der erste Termin
  }
  return out;
}

// Rapla schreibt Dozenten in die Beschreibung („… Personen: Name\, Vorname Ressourcen: …“)
function persons(desc) {
  const m = /Personen:\s*(.*?)\s*(?:Ressourcen:|$)/s.exec(desc || '');
  if (!m || !m[1].trim()) return [];
  const parts = m[1].split(',').map((x) => x.trim()).filter(Boolean);
  const names = [];
  for (let i = 0; i < parts.length; i += 2) names.push(parts[i + 1] ? `${parts[i + 1]} ${parts[i]}` : parts[i]);
  return names;
}

function parseIcs(text, { from, to }) {
  const events = [];
  let cur = null;
  let depth = 0;
  for (const line of unfold(text)) {
    if (/^BEGIN:VEVENT$/i.test(line)) { cur = { props: {}, exdate: [], rdate: [] }; depth = 0; continue; }
    if (!cur) continue;
    if (/^BEGIN:/i.test(line)) { depth++; continue; } // z. B. VALARM überspringen
    if (/^END:VEVENT$/i.test(line)) { events.push(cur); cur = null; continue; }
    if (/^END:/i.test(line)) { depth--; continue; }
    if (depth > 0) continue;
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === 'EXDATE') p.value.split(',').forEach((v) => cur.exdate.push({ value: v, params: p.params }));
    else if (p.name === 'RDATE') p.value.split(',').forEach((v) => cur.rdate.push({ value: v, params: p.params }));
    else if (!cur.props[p.name]) cur.props[p.name] = p;
  }

  const out = [];
  for (const ev of events) {
    const start = parseDate(ev.props.DTSTART);
    if (!start) continue;
    let end = parseDate(ev.props.DTEND);
    let dur;
    if (end) dur = end.utc - start.utc;
    else if (ev.props.DURATION) {
      const d = /P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/.exec(ev.props.DURATION.value) || [];
      dur = (((+d[1] || 0) * 7 + (+d[2] || 0)) * 24 * 3600 + (+d[3] || 0) * 3600 + (+d[4] || 0) * 60) * 1000;
    } else dur = start.allDay ? 86400000 : 0;
    const exdates = new Set(ev.exdate.map((x) => parseDate(x)).filter(Boolean).map((x) => wallKey(x.wall)));
    let starts = ev.props.RRULE ? expand(start, ev.props.RRULE.value, exdates, to) : [start.utc];
    starts = starts.concat(ev.rdate.map((x) => parseDate(x)).filter(Boolean).map((x) => x.utc));
    const desc = ev.props.DESCRIPTION ? unescapeText(ev.props.DESCRIPTION.value) : '';
    const base = {
      uid: ev.props.UID ? ev.props.UID.value : crypto.randomUUID(),
      title: ev.props.SUMMARY ? unescapeText(ev.props.SUMMARY.value).trim() : '(ohne Titel)',
      location: ev.props.LOCATION ? unescapeText(ev.props.LOCATION.value).trim() : '',
      persons: persons(desc),
      category: ev.props.CATEGORIES ? unescapeText(ev.props.CATEGORIES.value) : '',
      // Rapla legt Feiertage mit Uhrzeit-Start und Datums-Ende an
      allDay: start.allDay || !!(end && end.allDay) || dur >= 23 * 3600000,
    };
    for (const s of starts) {
      if (s + dur < from || s > to) continue;
      out.push({ ...base, id: `${base.uid}@${s}`, start: s, end: s + dur });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// ---------- Verwaltung + Cache ----------
class Timetables extends EventEmitter {
  constructor() {
    super();
    this.loading = new Map();
    this.timer = null;
  }

  list() {
    return (store.getSettings().timetables || []).map((t) => {
      const c = this.cached(t.id);
      return { ...t, fetchedAt: c ? c.fetchedAt : 0, count: c ? c.events.length : 0, error: c ? c.error || null : null };
    });
  }

  cachePath(id) {
    return store.file(path.join('cache', 'timetables', `${id}.json`));
  }

  cached(id) {
    return store.readJson(this.cachePath(id), null);
  }

  async add({ name, url }) {
    const ics = icalUrl(url);
    const list = store.getSettings().timetables || [];
    if (list.some((t) => icalUrl(t.url) === ics)) throw new Error('Dieser Stundenplan ist schon eingetragen.');
    const t = { id: crypto.randomBytes(6).toString('hex'), name: String(name || '').trim() || 'Stundenplan', url: String(url).trim() };
    // Erst laden, dann speichern: ungültige Links landen gar nicht erst in der Liste
    await this.fetch(t);
    store.setSettings({ timetables: [...list, t] });
    this.emit('changed');
    return t;
  }

  remove(id) {
    store.setSettings({ timetables: (store.getSettings().timetables || []).filter((t) => t.id !== id) });
    require('fs').rmSync(this.cachePath(id), { force: true });
    this.emit('changed');
  }

  async fetch(t) {
    if (this.loading.has(t.id)) return this.loading.get(t.id);
    const job = (async () => {
      const res = await fetch(icalUrl(t.url), { signal: AbortSignal.timeout(30000), headers: { Accept: 'text/calendar, */*' } });
      if (!res.ok) throw new Error(`Stundenplan nicht erreichbar (HTTP ${res.status})`);
      const text = await res.text();
      if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('Unter diesem Link liegt kein Kalender (iCal).');
      const now = Date.now();
      const events = parseIcs(text, { from: now - WINDOW_PAST_DAYS * 86400000, to: now + WINDOW_FUTURE_DAYS * 86400000 });
      store.writeJson(this.cachePath(t.id), { fetchedAt: now, events });
      return events.length;
    })();
    this.loading.set(t.id, job);
    try {
      return await job;
    } finally {
      this.loading.delete(t.id);
    }
  }

  // Alle Pläne aktualisieren; Fehler (z. B. offline) werden vermerkt, der alte Stand bleibt nutzbar
  async refreshAll() {
    for (const t of store.getSettings().timetables || []) {
      try {
        await this.fetch(t);
      } catch (e) {
        const c = this.cached(t.id);
        if (c) store.writeJson(this.cachePath(t.id), { ...c, error: e.message });
      }
    }
    this.emit('changed');
  }

  events(id, from, to) {
    const c = this.cached(id);
    if (!c) return [];
    return c.events.filter((e) => e.end >= from && e.start <= to);
  }

  start() {
    setTimeout(() => this.refreshAll(), 10 * 1000);
    this.timer = setInterval(() => this.refreshAll(), REFRESH_MS);
  }
}

module.exports = { Timetables, parseIcs, icalUrl, RAPLA_TEMPLATE };
