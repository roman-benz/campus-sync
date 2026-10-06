// Lokaler Volltextindex über alle synchronisierten Dokumente (seitengenau).
// Grundlage für die Dokumentsuche in der App und für die KI-Werkzeuge.
const { utilityProcess } = require('electron');
const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { canExtract } = require('./extract');

const MAX_BYTES = 80 * 1024 * 1024;
const TIMEOUT_MS = 90 * 1000;

// Kleinschreibung + Umlaute/Akzente vereinheitlichen, damit „Größe“ auch „Grosse“ trifft
const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

function parseQuery(q) {
  const terms = [];
  String(q || '').replace(/"([^"]+)"|(\S+)/g, (_m, phrase, word) => {
    const t = norm(phrase || word).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (t.length >= 2) terms.push(t);
    return '';
  });
  return [...new Set(terms)];
}

class DocIndex extends EventEmitter {
  constructor(sync) {
    super();
    this.sync = sync;
    this.docs = new Map(); // id → { tm, pages, normPages }
    this.loadedFor = null;
    this.queue = [];
    this.waiters = new Map();
    this.worker = null;
    this.busy = null;
    this.errors = {};
  }

  dir() {
    const site = this.sync.client ? this.sync.client.siteUrl : 'none';
    return store.file(path.join('cache', 'text', crypto.createHash('sha1').update(site).digest('hex').slice(0, 12)));
  }

  load() {
    const dir = this.dir();
    if (this.loadedFor === dir) return;
    this.docs.clear();
    this.errors = {};
    this.loadedFor = dir;
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        this.docs.set(d.id, { tm: d.tm, pages: d.pages, normPages: d.pages.map(norm) });
      } catch {}
    }
  }

  isIndexed(f) {
    const d = this.docs.get(f.id);
    return !!d && d.tm === f.timemodified;
  }

  status() {
    this.load();
    const files = this.sync.cache ? Object.values(this.sync.cache.files).filter((f) => canExtract(f.filename)) : [];
    const indexed = files.filter((f) => this.isIndexed(f)).length;
    return { indexed, total: files.length, running: !!this.busy, current: this.busy ? this.busy.filename : null };
  }

  // Alle heruntergeladenen, noch nicht (aktuell) indexierten Dokumente einreihen
  indexPending() {
    if (!this.sync.cache) return;
    this.load();
    for (const f of Object.values(this.sync.cache.files)) {
      if (!f.downloaded || !canExtract(f.filename) || this.isIndexed(f) || this.errors[f.id] === f.timemodified) continue;
      if (f.filesize && f.filesize > MAX_BYTES) continue;
      if (!this.queue.includes(f.id)) this.queue.push(f.id);
    }
    this.pump();
  }

  ensureIndexed(f) {
    this.load();
    if (this.isIndexed(f)) return Promise.resolve(this.docs.get(f.id));
    return new Promise((resolve, reject) => {
      const list = this.waiters.get(f.id) || [];
      list.push({ resolve, reject });
      this.waiters.set(f.id, list);
      this.queue = [f.id, ...this.queue.filter((x) => x !== f.id)]; // vorziehen
      this.pump();
    });
  }

  startWorker() {
    this.worker = utilityProcess.fork(path.join(__dirname, 'indexer-worker.js'), [], { serviceName: 'Campus Sync Index' });
    this.worker.on('message', (msg) => this.onResult(msg));
    this.worker.on('exit', () => {
      this.worker = null;
      if (this.busy) this.onResult({ id: this.busy.id, error: 'Indexprozess beendet' });
    });
  }

  pump() {
    if (this.busy || !this.queue.length || !this.sync.cache) {
      if (!this.busy && !this.queue.length) this.emit('progress', this.status());
      return;
    }
    const id = this.queue.shift();
    const f = this.sync.cache.files[id];
    if (!f || !f.downloaded || !fs.existsSync(f.localPath)) {
      this.finishWaiters(id, null, new Error('Datei ist nicht lokal vorhanden'));
      return this.pump();
    }
    if (!this.worker) this.startWorker();
    this.busy = { id, filename: f.filename, tm: f.timemodified };
    this.timer = setTimeout(() => this.worker && this.worker.kill(), TIMEOUT_MS);
    this.worker.postMessage({ id, file: f.localPath, filename: f.filename });
    this.emit('progress', this.status());
  }

  onResult({ id, pages, error }) {
    clearTimeout(this.timer);
    const job = this.busy;
    this.busy = null;
    if (!job || job.id !== id) return this.pump();
    if (error) {
      this.errors[id] = job.tm;
      this.finishWaiters(id, null, new Error(error));
    } else {
      const doc = { id, tm: job.tm, pages };
      try {
        fs.mkdirSync(this.dir(), { recursive: true });
        fs.writeFileSync(path.join(this.dir(), id + '.json'), JSON.stringify(doc));
      } catch {}
      const entry = { tm: job.tm, pages, normPages: pages.map(norm) };
      this.docs.set(id, entry);
      this.finishWaiters(id, entry);
    }
    this.pump();
  }

  finishWaiters(id, entry, err) {
    const list = this.waiters.get(id);
    if (!list) return;
    this.waiters.delete(id);
    for (const w of list) (err ? w.reject(err) : w.resolve(entry));
  }

  async getPages(fileId, from = 1, to = from) {
    const f = this.sync.cache && this.sync.cache.files[fileId];
    if (!f) throw new Error('Unbekannte file_id');
    if (!f.downloaded) await this.sync.ensureFile(fileId);
    const d = await this.ensureIndexed(f);
    const total = d.pages.length;
    const a = Math.max(1, Math.min(from, total));
    const b = Math.max(a, Math.min(to, total));
    return { total, pages: d.pages.slice(a - 1, b).map((text, i) => ({ n: a + i, text })) };
  }

  // Seitengenaue Volltextsuche. Treffer mit allen Begriffen zuerst, sonst die beste Teilübereinstimmung.
  search(query, { courseId = null, fileId = null, limit = 40, perFile = 4 } = {}) {
    this.load();
    const terms = parseQuery(query);
    if (!terms.length || !this.sync.cache) return { terms, hits: [] };
    const files = this.sync.cache.files;
    const hits = [];
    for (const [id, d] of this.docs) {
      const f = files[id];
      if (!f || (courseId && f.courseId !== courseId) || (fileId && id !== fileId)) continue;
      const nameNorm = norm(f.filename + ' ' + f.moduleName);
      d.normPages.forEach((t, i) => {
        let matched = 0;
        let score = 0;
        for (const term of terms) {
          let c = 0;
          let pos = t.indexOf(term);
          while (pos !== -1 && c < 25) {
            c++;
            pos = t.indexOf(term, pos + term.length);
          }
          if (c) matched++;
          score += c ? 3 + Math.log2(1 + c) * 2 : 0;
          if (nameNorm.includes(term)) score += 2;
        }
        if (!matched) return;
        hits.push({ fileId: id, page: i + 1, matched, score: score + (matched === terms.length ? 50 : 0), text: d.pages[i], normText: t });
      });
    }
    hits.sort((a, b) => b.score - a.score);
    const best = hits.length && hits[0].matched === terms.length ? hits.filter((h) => h.matched === terms.length) : hits;
    const counts = {};
    const out = [];
    for (const h of best) {
      counts[h.fileId] = (counts[h.fileId] || 0) + 1;
      if (counts[h.fileId] > perFile) continue;
      out.push({ fileId: h.fileId, page: h.page, score: Math.round(h.score), snippet: snippet(h.text, h.normText, terms) });
      if (out.length >= limit) break;
    }
    const totalFiles = new Set(best.map((h) => h.fileId)).size;
    return { terms, hits: out, totalPages: best.length, totalFiles };
  }
}

function snippet(text, normText, terms, len = 260) {
  let pos = -1;
  for (const t of terms) {
    const p = normText.indexOf(t);
    if (p !== -1 && (pos === -1 || p < pos)) pos = p;
  }
  if (pos === -1) pos = 0;
  // norm() verändert durch „ß→ss“ minimal die Länge – für einen Ausschnitt reicht die Näherung
  const start = Math.max(0, pos - Math.floor(len / 3));
  let s = text.slice(start, start + len).replace(/\s+/g, ' ').trim();
  if (start > 0) s = '… ' + s;
  if (start + len < text.length) s += ' …';
  return s;
}

module.exports = { DocIndex, norm, parseQuery };
