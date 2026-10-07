// „fs“ im Index-Worker: Die Seite schickt die Dateibytes mit, extract.js liest sie von hier.
const files = new Map();

function readFileSync(p, opts) {
  const data = files.get(p);
  if (!data) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  const enc = typeof opts === 'string' ? opts : opts && opts.encoding;
  return enc ? new TextDecoder().decode(data) : data;
}

module.exports = { files, readFileSync, existsSync: (p) => files.has(p) };
