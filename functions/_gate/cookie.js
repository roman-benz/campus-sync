// Zugangs-Cookie der Website: { sub, exp } + HMAC-SHA256 mit dem Pages-Secret GATE_SECRET.
// Wird nach einem Supabase-Login mit Freigabe ausgestellt (functions/api/gate.js) und von der
// Middleware bei jeder Anfrage geprüft – ohne Netzwerkzugriff.
export const COOKIE = 'chadoodle_gate';
export const MAX_AGE = 30 * 24 * 60 * 60;
export const SUPABASE_URL = 'https://btqpwjireatmmiyihnei.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_QsTZb0ccYAGJJkdWNvcckg_LzFYyibN';

const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

const key = (secret) => crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

export async function sign(payload, secret) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await key(secret), enc.encode(body));
  return `${body}.${b64url(sig)}`;
}

export async function verify(cookieHeader, secret) {
  if (!secret || !cookieHeader) return null;
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(cookieHeader);
  if (!m) return null;
  const [body, sig] = m[1].split('.');
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await key(secret), fromB64url(sig), enc.encode(body));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    return p.exp > Date.now() / 1000 ? p : null;
  } catch {
    return null;
  }
}

export const setCookie = (value, maxAge = MAX_AGE) => `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
