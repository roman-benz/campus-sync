// „path“ für Windows-Pfade in der Tauri-Version: POSIX-Logik (path-browserify), aber „\“ zählt
// als Trenner. Neue Pfade entstehen mit „/“ (versteht Windows genauso); alte Pfade aus dem
// Electron-Cache mit „\“ funktionieren weiter.
const posix = require('path-browserify');

const fix = (a) => (typeof a === 'string' ? a.replace(/\\/g, '/') : a);
const wrap = (fn) => (...args) => fn(...args.map(fix));
const isAbsolute = (p) => /^([a-zA-Z]:)?\//.test(fix(p));

function resolve(...parts) {
  let out = '';
  for (const p of parts.map(fix)) {
    if (!p) continue;
    out = isAbsolute(p) ? p : out ? out + '/' + p : p;
  }
  return posix.normalize(out || '/').replace(/\/+$/, '') || '/';
}

module.exports = {
  ...posix,
  join: wrap(posix.join),
  dirname: wrap(posix.dirname),
  basename: wrap(posix.basename),
  extname: wrap(posix.extname),
  normalize: wrap(posix.normalize),
  relative: wrap(posix.relative),
  parse: wrap(posix.parse),
  isAbsolute,
  resolve,
  sep: '/',
  delimiter: ';',
  posix,
  win32: null,
};
