// „crypto“ der Tauri-Version: SHA-1/MD5/Zufall wie in der Web-Version, dazu SHA-256 (PKCE)
// und die Prüfung von ID-Token-Signaturen (RS256/ES256) – beides synchron über Rust.
const base = require('../../web/shims/crypto.js');
const fs = require('fs');

const bytes = (d) => (typeof d === 'string' ? new TextEncoder().encode(d) : new Uint8Array(d.buffer || d, d.byteOffset || 0, d.byteLength));

function createHash(alg) {
  if (String(alg).toLowerCase() !== 'sha256') return base.createHash(alg);
  const parts = [];
  const h = {
    update(d) {
      parts.push(bytes(d));
      return h;
    },
    digest(enc) {
      const all = Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));
      const out = Buffer.from(fs.native('sha256', { b64: all.toString('base64') }).b64, 'base64');
      return enc ? out.toString(enc) : out;
    },
  };
  return h;
}

// Nur JWK-Schlüssel (so liefert sie der OIDC-Anbieter)
function createPublicKey(opts) {
  if (!opts || opts.format !== 'jwk') throw new Error('Nur JWK-Schlüssel werden unterstützt');
  return { jwk: opts.key };
}

function verify(alg, data, keyOrOpts, sig) {
  const key = keyOrOpts && keyOrOpts.key ? keyOrOpts.key : keyOrOpts;
  const jwtAlg = alg === 'RSA-SHA256' ? 'RS256' : 'ES256';
  return fs.native('jwtVerify', { jwk: key.jwk, alg: jwtAlg, data: Buffer.from(data).toString('utf8'), sig: Buffer.from(sig).toString('base64') }).ok;
}

module.exports = { ...base, createHash, createPublicKey, verify };
