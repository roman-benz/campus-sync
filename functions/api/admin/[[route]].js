// Admin-API für den Website-Zugang (nur für angemeldete Admins)
//
// GET    /api/admin/state                       Nutzer mit Passkeys, offene und letzte Einladungen
// POST   /api/admin/invites  { name, isAdmin, userId, hours }   Einladungslink erzeugen (Token nur in der Antwort)
// DELETE /api/admin/invites/<hash>              Einladung zurückziehen
// PATCH  /api/admin/users/<id>  { isAdmin }     Admin-Rechte ändern
// POST   /api/admin/users/<id>/logout           Überall abmelden
// DELETE /api/admin/users/<id>                  Nutzer samt Passkeys löschen
// DELETE /api/admin/credentials/<id>            einzelnen Passkey löschen
import { json, sameOrigin, readBody, getSession, randomToken, sha256, now, forgetSessions } from '../../_auth/lib.js';

export async function onRequest({ request, env, params }) {
  if (!env.AUTH_DB) return json({ error: 'Zugang ist nicht eingerichtet.' }, 503);
  const s = await getSession(request, env);
  if (!s) return json({ error: 'Nicht angemeldet' }, 401);
  if (!s.user.isAdmin) return json({ error: 'Nur für Admins' }, 403);
  if (request.method !== 'GET' && !sameOrigin(request)) return json({ error: 'Nicht erlaubt' }, 403);
  const [area, id, action] = [].concat(params.route || []);
  const db = env.AUTH_DB;

  if (request.method === 'GET' && area === 'state') {
    const [users, creds, invites] = await Promise.all([
      db.prepare('SELECT id, name, is_admin, created_at FROM users ORDER BY created_at').all(),
      db.prepare('SELECT id, user_id, label, created_at, last_used_at FROM credentials ORDER BY created_at').all(),
      db.prepare('SELECT token_hash, name, user_id, is_admin, created_at, expires_at, used_at, used_by FROM invites WHERE used_at IS NULL AND expires_at > ? OR used_at > ? ORDER BY created_at DESC')
        .bind(now(), now() - 14 * 86400).all(),
    ]);
    const sessions = await db.prepare('SELECT user_id, COUNT(*) n FROM sessions WHERE expires_at > ? GROUP BY user_id').bind(now()).all();
    const active = Object.fromEntries(sessions.results.map((r) => [r.user_id, r.n]));
    return json({
      me: s.user.id,
      users: users.results.map((u) => ({ id: u.id, name: u.name, isAdmin: !!u.is_admin, createdAt: u.created_at, sessions: active[u.id] || 0, passkeys: creds.results.filter((c) => c.user_id === u.id).map((c) => ({ id: c.id, label: c.label, createdAt: c.created_at, lastUsedAt: c.last_used_at })) })),
      invites: invites.results.map((i) => ({ hash: i.token_hash, name: i.name, userId: i.user_id, isAdmin: !!i.is_admin, createdAt: i.created_at, expiresAt: i.expires_at, usedAt: i.used_at })),
    });
  }

  if (area === 'invites' && request.method === 'POST' && !id) {
    const body = await readBody(request);
    let name = String(body.name || '').trim().slice(0, 60);
    let userId = null;
    if (body.userId) {
      const u = await db.prepare('SELECT id, name FROM users WHERE id = ?').bind(String(body.userId)).first();
      if (!u) return json({ error: 'Nutzer nicht gefunden' }, 404);
      userId = u.id;
      name = u.name;
    }
    if (!name) return json({ error: 'Bitte einen Namen angeben.' }, 400);
    const hours = Math.min(Math.max(Number(body.hours) || 72, 1), 24 * 30);
    const token = randomToken();
    const t = now();
    await db.prepare('INSERT INTO invites (token_hash, name, user_id, is_admin, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(await sha256(token), name, userId, !userId && body.isAdmin ? 1 : 0, s.user.id, t, t + hours * 3600).run();
    return json({ link: `${new URL(request.url).origin}/einladung#${token}`, expiresAt: t + hours * 3600 });
  }

  if (area === 'invites' && request.method === 'DELETE' && id) {
    await db.prepare('DELETE FROM invites WHERE token_hash = ? AND used_at IS NULL').bind(id).run();
    return json({ ok: true });
  }

  if (area === 'users' && id) {
    if (request.method === 'PATCH') {
      if (id === s.user.id) return json({ error: 'Die eigenen Admin-Rechte kannst du nicht ändern.' }, 400);
      const body = await readBody(request);
      await db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').bind(body.isAdmin ? 1 : 0, id).run();
      forgetSessions();
      return json({ ok: true });
    }
    if (request.method === 'POST' && action === 'logout') {
      await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run();
      forgetSessions();
      return json({ ok: true });
    }
    if (request.method === 'DELETE') {
      if (id === s.user.id) return json({ error: 'Dich selbst kannst du hier nicht löschen.' }, 400);
      await db.batch([
        db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
        db.prepare('DELETE FROM credentials WHERE user_id = ?').bind(id),
        db.prepare('DELETE FROM invites WHERE user_id = ?').bind(id),
        db.prepare('DELETE FROM users WHERE id = ?').bind(id),
      ]);
      forgetSessions();
      return json({ ok: true });
    }
  }

  if (area === 'credentials' && id && request.method === 'DELETE') {
    const c = await db.prepare('SELECT user_id FROM credentials WHERE id = ?').bind(id).first();
    if (!c) return json({ ok: true });
    if (c.user_id === s.user.id) {
      const { n } = await db.prepare('SELECT COUNT(*) n FROM credentials WHERE user_id = ?').bind(s.user.id).first();
      if (n <= 1) return json({ error: 'Das ist dein letzter Passkey – sonst kämst du nicht mehr rein.' }, 400);
    }
    await db.prepare('DELETE FROM credentials WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }

  return json({ error: 'Unbekannt' }, 404);
}
