// Volltextindex der Tauri-Version: gleiche Schnittstelle wie src/main/docindex.js, aber Speicher,
// Suche und Seitenabruf liegen in Rust (src-tauri/src/textindex.rs). Hier bleiben nur die
// Warteschlange und die Textextraktion (pdf.js im Worker, damit die Texte identisch sind).
const { utilityProcess } = require('electron');
const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('../src/main/store');
const { canExtract } = require('../src/main/extract');
const { norm, parseQuery } = require('../src/main/docindex');

const MAX_BYTES = 80 * 1024 * 1024;
const TIMEOUT_MS = 90 * 1000;
// pdf.js im Worker belegt viel Speicher – nach getaner Arbeit beenden (startet bei Bedarf neu)
const WORKER_IDLE_MS = 30 * 1000;

class DocIndex extends EventEmitter {
  constructor(sync) {
    super();
    this.sync = sync;
    this.docs = new Map(); // id → { tm, n } (nur Kennzahlen; die Texte liegen in Rust)
    this.loadedFor = null;
    this.queue = [];
    this.waiters = new Map();
    this.worker = null;
    this.idleTimer = null;
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
    const { docs } = fs.native('indexLoad', { dir });
    for (const [id, tm, n] of docs) this.docs.set(id, { tm, n });
  }

  isIndexed(f) {
    const d = this.docs.get(f.id);
    return !!d && d.tm === f.timemodified;
  }

  entry(id) {
    const d = this.docs.get(id);
    // ai-tools.js braucht nur die Seitenzahl (d.pages.length)
    return d && { tm: d.tm, pages: { length: d.n } };
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
    if (this.isIndexed(f)) return Promise.resolve(this.entry(f.id));
    return new Promise((resolve, reject) => {
      const list = this.waiters.get(f.id) || [];
      list.push({ resolve, reject });
      this.waiters.set(f.id, list);
      this.queue = [f.id, ...this.queue.filter((x) => x !== f.id)]; // vorziehen
      this.pump();
    });
  }

  startWorker() {
    this.worker = utilityProcess.fork('indexer', [], { serviceName: 'Chadoodle Index' });
    this.worker.on('message', (msg) => this.onResult(msg));
    this.worker.on('exit', () => {
      this.worker = null;
      if (this.busy) this.onResult({ id: this.busy.id, error: 'Indexprozess beendet' });
    });
  }

  stopWorkerLater() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.busy && !this.queue.length && this.worker) {
        const w = this.worker;
        this.worker = null;
        w.kill();
      }
    }, WORKER_IDLE_MS);
  }

  pump() {
    if (this.busy || !this.queue.length || !this.sync.cache) {
      if (!this.busy && !this.queue.length) {
        this.emit('progress', this.status());
        this.stopWorkerLater();
      }
      return;
    }
    clearTimeout(this.idleTimer);
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
      try {
        fs.native('indexPut', { dir: this.dir(), id, tm: job.tm, pages });
      } catch {}
      this.docs.set(id, { tm: job.tm, n: pages.length });
      this.finishWaiters(id, this.entry(id));
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
    return fs.native('indexPages', { dir: this.dir(), id: fileId, from: a, to: b });
  }

  // Seitengenaue Volltextsuche (Bewertung wie in src/main/docindex.js, gerechnet in Rust)
  search(query, { courseId = null, fileId = null, limit = 40, perFile = 4 } = {}) {
    this.load();
    const terms = parseQuery(query);
    if (!terms.length || !this.sync.cache) return { terms, hits: [] };
    const files = [];
    for (const [id, f] of Object.entries(this.sync.cache.files)) {
      if (!this.docs.has(id) || (courseId && f.courseId !== courseId) || (fileId && id !== fileId)) continue;
      files.push([id, norm(f.filename + ' ' + f.moduleName)]);
    }
    return fs.native('indexSearch', { terms, files, limit, perFile });
  }
}

module.exports = { DocIndex, norm, parseQuery };
