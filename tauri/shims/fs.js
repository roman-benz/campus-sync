// Ersatz für Nodes „fs“ in der Tauri-Version: echtes Dateisystem, synchron wie in Node.
// Jeder Aufruf ist ein synchroner XHR an das eigene Protokoll (src-tauri/src/protocol.rs, /cfs/…),
// den Rust auf einem Hintergrund-Thread erledigt. Kein Zwischenspeicher, keine doppelte Haltung im RAM.
const KEY = window.__CHADOODLE__.key;

function xhr(method, url, body, binary) {
  const r = new XMLHttpRequest();
  r.open(method, url, false);
  r.setRequestHeader('x-chadoodle-key', KEY);
  if (binary) r.overrideMimeType('text/plain; charset=x-user-defined');
  r.send(body === undefined ? null : body);
  return r;
}

function fail(r) {
  let e;
  try {
    e = JSON.parse(r.responseText);
  } catch {
    e = { code: 'EIO', message: r.responseText || `Dateizugriff fehlgeschlagen (HTTP ${r.status})` };
  }
  throw Object.assign(new Error(e.message), { code: e.code });
}

const q = (p) => encodeURIComponent(String(p));

function op(o) {
  const r = xhr('POST', '/cfs/op', JSON.stringify({ ...o, p: String(o.p), p2: o.p2 == null ? '' : String(o.p2) }));
  if (r.status !== 200) fail(r);
  return JSON.parse(r.responseText);
}

// Synchrone Hilfsfunktionen in Rust (DPAPI, SHA-256, Signaturprüfung)
function native(fn, args) {
  const r = xhr('POST', '/cfs/native', JSON.stringify({ fn, ...args }));
  if (r.status !== 200) fail(r);
  return JSON.parse(r.responseText);
}

const encOf = (opts) => (typeof opts === 'string' ? opts : opts && opts.encoding);

function readFileSync(p, opts) {
  const enc = encOf(opts);
  if (enc) {
    const r = xhr('GET', '/cfs/read?p=' + q(p));
    if (r.status !== 200) fail(r);
    return r.responseText;
  }
  const r = xhr('GET', '/cfs/read?p=' + q(p), undefined, true);
  if (r.status !== 200) fail(r);
  const s = r.responseText;
  const out = Buffer.allocUnsafe(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function toBody(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return String(data);
}

function writeFileSync(p, data) {
  const r = xhr('POST', '/cfs/write?p=' + q(p), toBody(data));
  if (r.status !== 200) fail(r);
}

function appendFileSync(p, data) {
  const r = xhr('POST', '/cfs/write?append=1&p=' + q(p), toBody(data));
  if (r.status !== 200) fail(r);
}

const existsSync = (p) => {
  try {
    return op({ op: 'exists', p }).v;
  } catch {
    return false;
  }
};

function statSync(p, opts = {}) {
  let s;
  try {
    s = op({ op: 'stat', p });
  } catch (e) {
    if (opts.throwIfNoEntry === false && e.code === 'ENOENT') return undefined;
    throw e;
  }
  return {
    size: s.size,
    mtimeMs: s.mtimeMs,
    mtime: new Date(s.mtimeMs),
    atimeMs: s.atimeMs,
    atime: new Date(s.atimeMs),
    birthtime: new Date(s.birthtimeMs),
    isFile: () => s.isFile,
    isDirectory: () => s.isDir,
    isSymbolicLink: () => false,
  };
}

function readdirSync(p, opts = {}) {
  const { names, dirs } = op({ op: 'readdir', p });
  if (!opts.withFileTypes) return names;
  return names.map((name, i) => ({ name, isDirectory: () => dirs[i], isFile: () => !dirs[i], isSymbolicLink: () => false }));
}

const mkdirSync = (p, opts = {}) => {
  op({ op: 'mkdir', p, recursive: !!(opts && opts.recursive) });
};
const rmSync = (p, opts = {}) => {
  op({ op: 'rm', p, recursive: !!opts.recursive, force: !!opts.force });
};
const unlinkSync = (p) => rmSync(p);
const rmdirSync = (p, opts = {}) => (opts.recursive ? rmSync(p, { recursive: true }) : op({ op: 'rmdir', p }));
const renameSync = (a, b) => {
  op({ op: 'rename', p: a, p2: b });
};
const secs = (t) => (t instanceof Date ? t.getTime() / 1000 : typeof t === 'string' ? Date.parse(t) / 1000 : Number(t));
const utimesSync = (p, atime, mtime) => {
  op({ op: 'utimes', p, atime: secs(atime), mtime: secs(mtime) });
};
const copyFileSync = (a, b) => writeFileSync(b, readFileSync(a));

function createWriteStream() {
  throw new Error('createWriteStream gibt es in der Tauri-Version nicht (Downloads laufen in Rust)');
}

// Asynchron (Index-Worker, PDF-Viewer): ohne die Oberfläche zu blockieren
async function readFileAsync(p) {
  const res = await fetch('/cfs/read?p=' + q(p), { headers: { 'x-chadoodle-key': KEY } });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ code: 'EIO', message: 'Lesen fehlgeschlagen' }));
    throw Object.assign(new Error(e.message), { code: e.code });
  }
  return new Uint8Array(await res.arrayBuffer());
}

module.exports = {
  native,
  readFileAsync,
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  statSync,
  lstatSync: statSync,
  readdirSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  rmdirSync,
  renameSync,
  utimesSync,
  copyFileSync,
  createWriteStream,
  promises: {},
};
