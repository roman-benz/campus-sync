// Gemeinsame Bausteine für den Passkey-Zugang der Website (Cloudflare Pages Functions + D1).
// Sitzungen und Einladungen stehen nur als SHA-256 ihres Tokens in der Datenbank.
export const SESSION_COOKIE = 'chadoodle_session';
export const SESSION_DAYS = 30;
export const RP_NAME = 'Chadoodle';
export const MAIN_HOST = 'chadoodle.romanbenz.com';

const enc = new TextEncoder();

export const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
export const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
export async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export const sha256B64url = async (s) => b64url(await crypto.subtle.digest('SHA-256', enc.encode(s)));
export const now = () => Math.floor(Date.now() / 1000);

// Passkeys gehören fest zu einer Domain (RP-ID). Nur die Hauptdomain und localhost (Entwicklung).
export function relyingParty(request) {
  const u = new URL(request.url);
  if (u.hostname === MAIN_HOST) return { rpID: MAIN_HOST, origin: `https://${MAIN_HOST}` };
  if (u.hostname === 'localhost') return { rpID: 'localhost', origin: u.origin };
  return null;
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
}

// Zustandsändernde Aufrufe nur von der eigenen Seite (Schutz vor Cross-Site-Anfragen)
export function sameOrigin(request) {
  const origin = request.headers.get('origin');
  return !!origin && origin === new URL(request.url).origin;
}

export const readBody = (request) => request.json().catch(() => ({}));

function cookieValue(request, name) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(request.headers.get('cookie') || '');
  return m ? m[1] : null;
}

const sessionCookie = (value, maxAge) => `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

// Kurzer Zwischenspeicher pro Worker-Instanz, damit nicht jede Datei-Anfrage die Datenbank fragt
const cache = new Map();
const CACHE_MS = 30 * 1000;

// Desktop-App: Sitzungstoken im Authorization-Header statt im Cookie
export const bearer = (request) => {
  const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(request.headers.get('authorization') || '');
  return m ? m[1] : null;
};

export async function getSession(request, env) {
  const token = bearer(request) || cookieValue(request, SESSION_COOKIE);
  if (!token || !env.AUTH_DB) return null;
  const hash = await sha256(token);
  const hit = cache.get(hash);
  if (hit && hit.until > Date.now()) return hit.session;
  const row = await env.AUTH_DB.prepare(
    'SELECT s.token_hash, s.expires_at, u.id, u.name, u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?',
  ).bind(hash, now()).first();
  const session = row ? { hash, user: { id: row.id, name: row.name, isAdmin: !!row.is_admin } } : null;
  cache.set(hash, { session, until: Date.now() + CACHE_MS });
  if (cache.size > 500) cache.clear();
  return session;
}

export async function createSession(env, userId) {
  return sessionCookie(await createSessionToken(env, userId), SESSION_DAYS * 86400);
}

export async function createSessionToken(env, userId) {
  const token = randomToken();
  const t = now();
  await env.AUTH_DB.batch([
    env.AUTH_DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(await sha256(token), userId, t, t + SESSION_DAYS * 86400),
    // Bei der Gelegenheit Abgelaufenes aufräumen
    env.AUTH_DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(t),
    env.AUTH_DB.prepare('DELETE FROM challenges WHERE expires_at < ?').bind(t),
  ]);
  return token;
}

export async function endSession(request, env) {
  const s = await getSession(request, env);
  if (s) {
    await env.AUTH_DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(s.hash).run();
    cache.delete(s.hash);
  }
  return sessionCookie('', 0);
}

export const forgetSessions = () => cache.clear();

// Einmal-Challenge speichern und genau einmal wieder abholen
export async function saveChallenge(env, kind, challenge, data) {
  const id = randomToken(16);
  await env.AUTH_DB.prepare('INSERT INTO challenges (id, challenge, kind, data, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, challenge, kind, JSON.stringify(data || {}), now() + 5 * 60).run();
  return id;
}

export async function takeChallenge(env, id, kind) {
  if (!id || typeof id !== 'string') return null;
  const row = await env.AUTH_DB.prepare('DELETE FROM challenges WHERE id = ? AND kind = ? AND expires_at > ? RETURNING challenge, data').bind(id, kind, now()).first();
  return row ? { challenge: row.challenge, data: JSON.parse(row.data || '{}') } : null;
}

export async function findInvite(env, token) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const hash = await sha256(token);
  const row = await env.AUTH_DB.prepare('SELECT * FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?').bind(hash, now()).first();
  return row ? { ...row, hash } : null;
}
