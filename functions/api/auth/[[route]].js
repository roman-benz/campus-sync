// Passkey-Anmeldung der Website (WebAuthn, geprüft mit @simplewebauthn/server)
//
// POST /api/auth/register/options  { token }            Einladung einlösen: Optionen für einen neuen Passkey
// POST /api/auth/register/options  { add: true }        Angemeldet: weiteren Passkey für sich selbst anlegen
// POST /api/auth/register/verify   { challengeId, response, label }
// POST /api/auth/login/options
// POST /api/auth/login/verify      { challengeId, response }
// POST /api/auth/logout                                 (Desktop-App: mit Authorization: Bearer)
// POST /api/auth/app/verify     { challengeId, response, codeChallenge }   Desktop-App: Passkey prüfen → Einmal-Code
// POST /api/auth/app/token      { code, verifier }     Desktop-App tauscht den Code (PKCE) gegen ein Sitzungstoken
// GET  /api/auth/me
// GET  /api/auth/invite?token=…     Name aus einer gültigen Einladung (für die Einladungsseite)
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { RP_NAME, relyingParty, json, sameOrigin, readBody, bearer, getSession, createSession, createSessionToken, endSession, saveChallenge, takeChallenge, findInvite, fromB64url, b64url, randomToken, now, sha256B64url } from '../../_auth/lib.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function onRequest(context) {
  const { request, env, params } = context;
  if (!env.AUTH_DB) return json({ error: 'Zugang ist nicht eingerichtet.' }, 503);
  const route = [].concat(params.route || []).join('/');
  const rp = relyingParty(request);
  if (!rp) return json({ error: 'Bitte über https://chadoodle.romanbenz.com anmelden.' }, 400);

  if (request.method === 'GET') {
    if (route === 'me') {
      const s = await getSession(request, env);
      return s ? json({ user: s.user }) : json({ error: 'Nicht angemeldet' }, 401);
    }
    if (route === 'invite') {
      const inv = await findInvite(env, new URL(request.url).searchParams.get('token'));
      return inv ? json({ name: inv.name, existing: !!inv.user_id, expiresAt: inv.expires_at }) : json({ error: 'Diese Einladung ist ungültig, abgelaufen oder wurde schon benutzt.' }, 404);
    }
    return json({ error: 'Unbekannt' }, 404);
  }
  if (request.method !== 'POST') return json({ error: 'Nicht erlaubt' }, 405);
  // Ausnahmen: Die Desktop-App schickt kein Origin (Code-Tausch, Aufrufe mit Bearer-Token).
  // Ein Bearer-Token kann eine fremde Seite nicht mitschicken, ein Cookie schon.
  if (route !== 'app/token' && !bearer(request) && !sameOrigin(request)) return json({ error: 'Nicht erlaubt' }, 403);
  const body = await readBody(request);

  try {
    switch (route) {
      case 'register/options': return await registerOptions(request, env, rp, body);
      case 'register/verify': return await registerVerify(request, env, rp, body);
      case 'login/options': return await loginOptions(env, rp);
      case 'login/verify': return await loginVerify(env, rp, body);
      case 'app/verify': return await appVerify(env, rp, body);
      case 'app/token': return await appToken(env, body);
      case 'logout': return json({ ok: true }, 200, { 'Set-Cookie': await endSession(request, env) });
      default: return json({ error: 'Unbekannt' }, 404);
    }
  } catch (e) {
    console.error(route, e);
    return json({ error: 'Das hat nicht geklappt. Bitte erneut versuchen.' }, 500);
  }
}

async function registerOptions(request, env, rp, body) {
  let user;
  let invite = null;
  if (body.add) {
    const s = await getSession(request, env);
    if (!s) return json({ error: 'Bitte zuerst anmelden.' }, 401);
    user = { id: s.user.id, name: s.user.name, isAdmin: s.user.isAdmin, existing: true };
  } else {
    invite = await findInvite(env, body.token);
    if (!invite) return json({ error: 'Diese Einladung ist ungültig, abgelaufen oder wurde schon benutzt.' }, 404);
    if (invite.user_id) {
      const u = await env.AUTH_DB.prepare('SELECT id, name, is_admin FROM users WHERE id = ?').bind(invite.user_id).first();
      if (!u) return json({ error: 'Der Nutzer zu dieser Einladung existiert nicht mehr.' }, 404);
      user = { id: u.id, name: u.name, isAdmin: !!u.is_admin, existing: true };
    } else {
      user = { id: randomToken(16), name: invite.name, isAdmin: !!invite.is_admin, existing: false };
    }
  }
  const { results: creds } = await env.AUTH_DB.prepare('SELECT id, transports FROM credentials WHERE user_id = ?').bind(user.id).all();
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rp.rpID,
    userName: user.name,
    userDisplayName: user.name,
    userID: enc.encode(user.id),
    attestationType: 'none',
    excludeCredentials: creds.map((c) => ({ id: c.id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });
  const challengeId = await saveChallenge(env, 'register', options.challenge, { user, inviteHash: invite ? invite.hash : null });
  return json({ challengeId, options });
}

async function registerVerify(request, env, rp, body) {
  const ch = await takeChallenge(env, body.challengeId, 'register');
  if (!ch) return json({ error: 'Die Anfrage ist abgelaufen. Bitte erneut versuchen.' }, 400);
  const { user, inviteHash } = ch.data;
  let v;
  try {
    v = await verifyRegistrationResponse({ response: body.response, expectedChallenge: ch.challenge, expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: false });
  } catch (e) {
    return json({ error: 'Der Passkey konnte nicht geprüft werden.' }, 400);
  }
  if (!v.verified || !v.registrationInfo) return json({ error: 'Der Passkey konnte nicht geprüft werden.' }, 400);
  const { credential } = v.registrationInfo;
  const t = now();

  // Einladung genau einmal einlösen (parallel abgeschickte Versuche verlieren hier)
  if (inviteHash) {
    const r = await env.AUTH_DB.prepare('UPDATE invites SET used_at = ?, used_by = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?').bind(t, user.id, inviteHash, t).run();
    if (!r.meta.changes) return json({ error: 'Diese Einladung wurde gerade schon benutzt.' }, 409);
  }
  const label = String(body.label || '').trim().slice(0, 60) || 'Passkey';
  const stmts = [];
  if (!user.existing) stmts.push(env.AUTH_DB.prepare('INSERT INTO users (id, name, is_admin, created_at) VALUES (?, ?, ?, ?)').bind(user.id, user.name, user.isAdmin ? 1 : 0, t));
  stmts.push(
    env.AUTH_DB.prepare('INSERT INTO credentials (id, user_id, public_key, counter, transports, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(credential.id, user.id, b64url(credential.publicKey), credential.counter || 0, JSON.stringify(credential.transports || []), label, t),
  );
  await env.AUTH_DB.batch(stmts);

  // Wer schon angemeldet war (weiterer Passkey), bleibt in seiner Sitzung
  const s = await getSession(request, env);
  if (s && s.user.id === user.id) return json({ ok: true });
  return json({ ok: true }, 200, { 'Set-Cookie': await createSession(env, user.id) });
}

async function loginOptions(env, rp) {
  // Ohne allowCredentials: Der Browser bietet alle Passkeys für diese Domain an
  const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: 'preferred' });
  const challengeId = await saveChallenge(env, 'login', options.challenge);
  return json({ challengeId, options });
}

// Passkey-Antwort prüfen → Nutzer-ID, oder eine Fehlerantwort
async function checkPasskey(env, rp, body) {
  const ch = await takeChallenge(env, body.challengeId, 'login');
  if (!ch) return json({ error: 'Die Anfrage ist abgelaufen. Bitte erneut versuchen.' }, 400);
  const id = body.response && body.response.id;
  const cred = id ? await env.AUTH_DB.prepare('SELECT * FROM credentials WHERE id = ?').bind(String(id)).first() : null;
  if (!cred) return json({ error: 'Dieser Passkey ist hier nicht (mehr) registriert.' }, 401);
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: ch.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: false,
      credential: { id: cred.id, publicKey: fromB64url(cred.public_key), counter: cred.counter, transports: cred.transports ? JSON.parse(cred.transports) : undefined },
    });
  } catch (e) {
    return json({ error: 'Anmeldung fehlgeschlagen.' }, 401);
  }
  if (!v.verified) return json({ error: 'Anmeldung fehlgeschlagen.' }, 401);
  // Falls der Authenticator eine user.id mitschickt, muss sie zum gespeicherten Nutzer passen
  const handle = body.response.response && body.response.response.userHandle;
  if (handle && dec.decode(fromB64url(handle)) !== cred.user_id) return json({ error: 'Anmeldung fehlgeschlagen.' }, 401);
  await env.AUTH_DB.prepare('UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?').bind(v.authenticationInfo.newCounter, now(), cred.id).run();
  return cred.user_id;
}

async function loginVerify(env, rp, body) {
  const userId = await checkPasskey(env, rp, body);
  if (userId instanceof Response) return userId;
  return json({ ok: true }, 200, { 'Set-Cookie': await createSession(env, userId) });
}

// Desktop-App, Schritt 1 (auf /app-login im Browser): Passkey prüfen, Einmal-Code für die App ausgeben.
// Der Code taugt nur zusammen mit dem Geheimnis (PKCE-Verifier), das die App nie aus der Hand gibt.
async function appVerify(env, rp, body) {
  const codeChallenge = String(body.codeChallenge || '');
  if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) return json({ error: 'Ungültige Anfrage der App. Bitte die Anmeldung in der App neu starten.' }, 400);
  const userId = await checkPasskey(env, rp, body);
  if (userId instanceof Response) return userId;
  const code = await saveChallenge(env, 'appcode', codeChallenge, { userId });
  return json({ code });
}

// Desktop-App, Schritt 2: Code + Verifier → Sitzungstoken (gilt wie eine Browser-Sitzung, im Admin-Dashboard sichtbar)
async function appToken(env, body) {
  const ch = await takeChallenge(env, body.code, 'appcode');
  if (!ch || typeof body.verifier !== 'string' || (await sha256B64url(body.verifier)) !== ch.challenge) return json({ error: 'Die Anmeldung ist abgelaufen oder ungültig. Bitte erneut versuchen.' }, 400);
  const u = await env.AUTH_DB.prepare('SELECT id, name, is_admin FROM users WHERE id = ?').bind(ch.data.userId).first();
  if (!u) return json({ error: 'Dieser Nutzer existiert nicht mehr.' }, 401);
  return json({ token: await createSessionToken(env, u.id), user: { id: u.id, name: u.name, isAdmin: !!u.is_admin } });
}
