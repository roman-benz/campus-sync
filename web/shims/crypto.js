// Ersatz für Nodes „crypto“: synchrone SHA-1/MD5 (Datei-IDs, Cache-Namen, SSO-Signatur) und Zufallswerte.
const utf8 = (s) => (typeof s === 'string' ? new TextEncoder().encode(s) : new Uint8Array(s.buffer || s, s.byteOffset || 0, s.byteLength));
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const rotl = (x, n) => (x << n) | (x >>> (32 - n));

// Nachricht auf Vielfache von 64 Byte auffüllen (Länge in Bit am Ende, big- oder little-endian)
function pad(msg, littleEndian) {
  const len = msg.length;
  const total = (((len + 8) >> 6) + 1) << 6;
  const out = new Uint8Array(total);
  out.set(msg);
  out[len] = 0x80;
  const dv = new DataView(out.buffer);
  const bits = len * 8;
  if (littleEndian) {
    dv.setUint32(total - 8, bits >>> 0, true);
    dv.setUint32(total - 4, Math.floor(bits / 2 ** 32), true);
  } else {
    dv.setUint32(total - 8, Math.floor(bits / 2 ** 32));
    dv.setUint32(total - 4, bits >>> 0);
  }
  return dv;
}

function sha1(msg) {
  const dv = pad(msg, false);
  let [a0, b0, c0, d0, e0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Int32Array(80);
  for (let off = 0; off < dv.byteLength; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getInt32(off + i * 4);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let [a, b, c, d, e] = [a0, b0, c0, d0, e0];
    for (let i = 0; i < 80; i++) {
      const [f, k] = i < 20 ? [(b & c) | (~b & d), 0x5a827999] : i < 40 ? [b ^ c ^ d, 0x6ed9eba1] : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc] : [b ^ c ^ d, 0xca62c1d6];
      const t = (rotl(a, 5) + f + e + k + w[i]) | 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = t;
    }
    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
    e0 = (e0 + e) | 0;
  }
  const out = new DataView(new ArrayBuffer(20));
  [a0, b0, c0, d0, e0].forEach((v, i) => out.setInt32(i * 4, v));
  return new Uint8Array(out.buffer);
}

const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0);
function md5(msg) {
  const dv = pad(msg, true);
  let [a0, b0, c0, d0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let off = 0; off < dv.byteLength; off += 64) {
    const m = Array.from({ length: 16 }, (_, i) => dv.getInt32(off + i * 4, true));
    let [a, b, c, d] = [a0, b0, c0, d0];
    for (let i = 0; i < 64; i++) {
      const r = i >> 4;
      const [f, g] = r === 0 ? [(b & c) | (~b & d), i] : r === 1 ? [(d & b) | (~d & c), (5 * i + 1) % 16] : r === 2 ? [b ^ c ^ d, (3 * i + 5) % 16] : [c ^ (b | ~d), (7 * i) % 16];
      const t = d;
      d = c;
      c = b;
      b = (b + rotl((a + f + MD5_K[i] + m[g]) | 0, MD5_S[r * 4 + (i % 4)])) | 0;
      a = t;
    }
    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }
  const out = new DataView(new ArrayBuffer(16));
  [a0, b0, c0, d0].forEach((v, i) => out.setInt32(i * 4, v, true));
  return new Uint8Array(out.buffer);
}

const ALGOS = { sha1, md5 };

function createHash(alg) {
  const fn = ALGOS[String(alg).toLowerCase()];
  if (!fn) throw new Error(`Hash ${alg} wird im Browser nicht unterstützt`);
  const parts = [];
  const h = {
    update(data) {
      parts.push(utf8(data));
      return h;
    },
    digest(enc) {
      const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let o = 0;
      for (const p of parts) {
        all.set(p, o);
        o += p.length;
      }
      const d = fn(all);
      return enc === 'hex' ? hex(d) : Buffer.from(d);
    },
  };
  return h;
}

function randomBytes(n) {
  return Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(n)));
}

const randomUUID = () => globalThis.crypto.randomUUID();

module.exports = { createHash, randomBytes, randomUUID, webcrypto: globalThis.crypto };
