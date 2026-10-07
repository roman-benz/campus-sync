// Ersatz für Nodes „fs“ im Browser. Die Module des Hauptprozesses arbeiten synchron mit Dateien –
// deshalb liegen kleine Dateien komplett im Speicher und werden im Hintergrund nach IndexedDB
// geschrieben. Große Kursdateien („blobs“) liest man asynchron; vor synchronem Lesen lädt
// preload() sie in einen begrenzten Zwischenspeicher.
const path = require('path');
const idb = require('./idb');

const files = new Map(); // Pfad → { data: string|Uint8Array, mtime }
const blobs = new Map(); // Pfad → { size, mtime }
const dirs = new Set(['/']);
const hot = new Map(); // Pfad → Uint8Array (zuletzt gelesene Blobs, LRU)
const HOT_MAX = 160 * 1024 * 1024;
let hotBytes = 0;

const norm = (p) => {
  const s = path.normalize('/' + String(p).replace(/\\/g, '/'));
  return s.length > 1 ? s.replace(/\/+$/, '') : s;
};

function addDirs(p) {
  let d = path.dirname(p);
  while (!dirs.has(d)) {
    dirs.add(d);
    d = path.dirname(d);
  }
}

const enoent = (p) => Object.assign(new Error(`ENOENT: no such file or directory, '${p}'`), { code: 'ENOENT' });

// ---------- Schreiben nach IndexedDB (gebündelt) ----------
let pending = new Map(); // `${store}|${key}` → op
let flushTimer = null;
let flushing = Promise.resolve();
function queue(store, key, value) {
  pending.set(`${store}|${key}`, { store, key, value });
  if (!flushTimer) flushTimer = setTimeout(flush, 120);
}
function flush() {
  clearTimeout(flushTimer);
  flushTimer = null;
  const ops = [...pending.values()];
  pending = new Map();
  flushing = flushing.then(() => idb.write(ops)).catch((e) => console.error('Speichern fehlgeschlagen', e));
  return flushing;
}

async function init() {
  const [all, meta] = await Promise.all([idb.getAll('files'), idb.getAll('blobmeta')]);
  for (const [k, v] of all) {
    files.set(k, v);
    addDirs(k);
  }
  for (const [k, v] of meta) {
    blobs.set(k, v);
    addDirs(k);
  }
}

function remember(p, data) {
  if (hot.has(p)) hotBytes -= hot.get(p).byteLength;
  hot.delete(p);
  if (data.byteLength > HOT_MAX / 2) return;
  hot.set(p, data);
  hotBytes += data.byteLength;
  for (const [k, v] of hot) {
    if (hotBytes <= HOT_MAX) break;
    hot.delete(k);
    hotBytes -= v.byteLength;
  }
}

// ---------- Asynchrone Zusatzfunktionen (nur Web) ----------
async function readFileAsync(p) {
  p = norm(p);
  const f = files.get(p);
  if (f) return typeof f.data === 'string' ? new TextEncoder().encode(f.data) : f.data;
  if (!blobs.has(p)) throw enoent(p);
  if (hot.has(p)) return hot.get(p);
  await flushing;
  let data = await idb.get('blobs', p);
  if (data === undefined) throw enoent(p);
  if (data instanceof Blob) data = new Uint8Array(await data.arrayBuffer());
  remember(p, data);
  return data;
}

async function writeBlob(p, data) {
  p = norm(p);
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const meta = { size: bytes.byteLength, mtime: Date.now() };
  await flushing;
  await idb.write([
    { store: 'blobs', key: p, value: bytes },
    { store: 'blobmeta', key: p, value: meta },
  ]);
  files.delete(p);
  blobs.set(p, meta);
  addDirs(p);
  remember(p, bytes);
}

async function preload(p) {
  try {
    await readFileAsync(p);
  } catch {}
}

function allPaths() {
  return [...files.keys(), ...blobs.keys()];
}

// ---------- fs-API (synchron) ----------
function existsSync(p) {
  p = norm(p);
  return files.has(p) || blobs.has(p) || dirs.has(p);
}

function readFileSync(p, opts) {
  p = norm(p);
  const enc = typeof opts === 'string' ? opts : opts && opts.encoding;
  let data;
  const f = files.get(p);
  if (f) data = f.data;
  else if (hot.has(p)) data = hot.get(p);
  else throw enoent(p);
  if (enc) return typeof data === 'string' ? data : new TextDecoder().decode(data);
  return typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function writeFileSync(p, data) {
  p = norm(p);
  if (typeof data !== 'string') data = new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data);
  const entry = { data, mtime: Date.now() };
  if (blobs.has(p)) unlinkBlob(p);
  files.set(p, entry);
  addDirs(p);
  queue('files', p, entry);
}

function appendFileSync(p, data) {
  const prev = existsSync(p) ? readFileSync(p, 'utf8') : '';
  writeFileSync(p, prev + String(data));
}

function unlinkBlob(p) {
  blobs.delete(p);
  if (hot.has(p)) hotBytes -= hot.get(p).byteLength;
  hot.delete(p);
  queue('blobs', p, undefined);
  queue('blobmeta', p, undefined);
}

function unlink(p) {
  if (files.delete(p)) queue('files', p, undefined);
  if (blobs.has(p)) unlinkBlob(p);
}

function renameSync(a, b) {
  a = norm(a);
  b = norm(b);
  const f = files.get(a);
  if (f) {
    files.delete(a);
    queue('files', a, undefined);
    files.set(b, f);
    addDirs(b);
    queue('files', b, f);
    return;
  }
  if (!blobs.has(a)) throw enoent(a);
  // Blobs werden nie umbenannt (Downloads schreiben direkt ans Ziel)
  throw new Error('rename von Kursdateien wird nicht unterstützt');
}

function rmSync(p, opts = {}) {
  p = norm(p);
  if (files.has(p) || blobs.has(p)) return unlink(p);
  if (dirs.has(p) && opts.recursive) {
    const prefix = p === '/' ? '/' : p + '/';
    for (const k of allPaths()) if (k.startsWith(prefix)) unlink(k);
    for (const d of [...dirs]) if (d.startsWith(prefix) || d === p) dirs.delete(d);
    return;
  }
  if (!opts.force && !dirs.has(p)) throw enoent(p);
}

function mkdirSync(p) {
  p = norm(p);
  dirs.add(p);
  addDirs(p);
}

function rmdirSync(p) {
  p = norm(p);
  const prefix = p + '/';
  if (allPaths().some((k) => k.startsWith(prefix))) throw Object.assign(new Error('ENOTEMPTY'), { code: 'ENOTEMPTY' });
  dirs.delete(p);
}

function readdirSync(p, opts = {}) {
  p = norm(p);
  const prefix = p === '/' ? '/' : p + '/';
  const names = new Map();
  for (const k of allPaths()) if (k.startsWith(prefix)) {
    const rest = k.slice(prefix.length);
    const i = rest.indexOf('/');
    names.set(i === -1 ? rest : rest.slice(0, i), i !== -1);
  }
  for (const d of dirs) if (d.startsWith(prefix) && d !== p) {
    const rest = d.slice(prefix.length);
    if (rest && !rest.includes('/')) names.set(rest, true);
  }
  if (!names.size && !dirs.has(p)) throw enoent(p);
  const list = [...names.keys()].sort();
  if (!opts.withFileTypes) return list;
  return list.map((name) => ({ name, isDirectory: () => names.get(name), isFile: () => !names.get(name) }));
}

function statSync(p) {
  p = norm(p);
  const f = files.get(p);
  const b = blobs.get(p);
  if (!f && !b && !dirs.has(p)) throw enoent(p);
  const size = f ? (typeof f.data === 'string' ? new TextEncoder().encode(f.data).byteLength : f.data.byteLength) : b ? b.size : 0;
  const mtime = new Date((f || b || {}).mtime || 0);
  return { size, mtime, mtimeMs: mtime.getTime(), isFile: () => !!(f || b), isDirectory: () => !f && !b };
}

const utimesSync = () => {};

function createWriteStream() {
  throw new Error('createWriteStream ist im Browser nicht verfügbar');
}

module.exports = {
  // Web
  init, flush, readFileAsync, writeBlob, preload, allPaths, norm,
  // fs
  existsSync, readFileSync, writeFileSync, appendFileSync, renameSync, rmSync, mkdirSync, rmdirSync,
  readdirSync, statSync, utimesSync, createWriteStream,
  promises: {},
};
