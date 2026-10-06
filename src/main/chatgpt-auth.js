// „Sign in with ChatGPT“ mit ChatGPT-Plan-Nutzung (OAuth 2.0 + PKCE, Loopback-Redirect).
// Erste Anmeldung registriert die App dynamisch (dynamic_agent_client); die vergebene client_id
// wird pro Konto gespeichert und bei späteren Anmeldungen wiederverwendet.
// Doku: https://developers.openai.com/siwc/token-sharing-open-source
const { shell } = require('electron');
const http = require('http');
const crypto = require('crypto');
const store = require('./store');

// Nur für Tests überschreibbar
const ISSUER = process.env.MOODLE_DESKTOP_OPENAI_AUTH || 'https://auth.openai.com';
const AUTH_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const CALLBACK_PATH = '/auth/callback';
const PORTS = [1455, 1456, 1457, 1458, 1459, 0];
const APP_NAME = 'Moodle Desktop';
const SECRET_KEY = 'chatgptAccount';
const REFRESH_FAIL = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);

const fs = require('fs');
const path = require('path');

// Protokoll ohne Geheimnisse (Codes/Tokens werden nie geschrieben) – hilft bei Anmeldeproblemen
const LOG_FILE = () => store.file(path.join('logs', 'chatgpt.log'));
function log(msg) {
  try {
    const f = LOG_FILE();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (fs.existsSync(f) && fs.statSync(f).size > 256 * 1024) fs.renameSync(f, f + '.old');
    fs.appendFileSync(f, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}
const mask = (id) => (id ? String(id).slice(0, 10) + '…' : '–');

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

class AuthRequiredError extends Error {
  constructor(msg = 'Bitte erneut mit ChatGPT anmelden.') {
    super(msg);
    this.code = 'auth_required';
  }
}

let oidcConfig = null;
async function oidc() {
  if (oidcConfig) return oidcConfig;
  try {
    const r = await fetch(`${ISSUER}/.well-known/openid-configuration`);
    if (r.ok) oidcConfig = await r.json();
  } catch {}
  oidcConfig = oidcConfig || {};
  oidcConfig.jwks_uri = oidcConfig.jwks_uri || `${ISSUER}/.well-known/jwks.json`;
  return oidcConfig;
}

async function verifyIdToken(idToken, { clientId, nonce }) {
  const [h, p, s] = String(idToken).split('.');
  if (!h || !p || !s) throw new Error('Ungültiges ID-Token');
  const header = JSON.parse(fromB64url(h).toString('utf8'));
  const claims = JSON.parse(fromB64url(p).toString('utf8'));
  const { jwks_uri } = await oidc();
  const jwks = await (await fetch(jwks_uri)).json();
  const jwk = (jwks.keys || []).find((k) => k.kid === header.kid) || (jwks.keys || [])[0];
  if (!jwk) throw new Error('Signaturschlüssel nicht gefunden');
  const alg = header.alg === 'RS256' ? 'RSA-SHA256' : header.alg === 'ES256' ? 'SHA256' : null;
  if (!alg) throw new Error('Nicht unterstützter Signaturalgorithmus ' + header.alg);
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const ok = crypto.verify(alg, Buffer.from(`${h}.${p}`), header.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key, fromB64url(s));
  if (!ok) throw new Error('ID-Token-Signatur ungültig');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== ISSUER) throw new Error('ID-Token: falscher Aussteller');
  if (!aud.includes(clientId)) throw new Error('ID-Token: falsche Zielgruppe');
  if (claims.exp && claims.exp * 1000 < Date.now() - 60000) throw new Error('ID-Token abgelaufen');
  if (nonce && claims.nonce !== nonce) throw new Error('ID-Token: nonce passt nicht');
  return claims;
}

function listen() {
  return new Promise((resolve, reject) => {
    let i = 0;
    const tryPort = () => {
      const server = http.createServer();
      server.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && i < PORTS.length - 1) {
          i++;
          tryPort();
        } else reject(e);
      });
      server.listen(PORTS[i], '127.0.0.1', () => resolve(server));
    };
    tryPort();
  });
}

const page = (title, text, ok = true) => `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:"Segoe UI",system-ui,sans-serif;background:#f4f6f9;color:#1d2125;display:grid;place-items:center;height:100vh;margin:0}
.c{background:#fff;border:1px solid #e2e6ec;border-radius:18px;padding:32px 36px;max-width:420px;text-align:center;box-shadow:0 12px 40px rgba(16,24,40,.12)}
.i{width:52px;height:52px;border-radius:50%;margin:0 auto 14px;display:grid;place-items:center;font-size:26px;color:#fff;background:${ok ? '#357a32' : '#ca3120'}}
h1{font-size:20px;margin:0 0 6px}p{color:#5f6871;margin:0}</style></head>
<body><div class="c"><div class="i">${ok ? '✓' : '!'}</div><h1>${title}</h1><p>${text}</p></div></body></html>`;

class ChatGPTAuth {
  constructor() {
    this.refreshing = null;
    this.pending = null;
  }

  hostId() {
    let id = store.getSettings().chatgptHostId;
    if (!id) {
      id = `urn:uuid:${crypto.randomUUID()}`;
      store.setSettings({ chatgptHostId: id });
    }
    return id;
  }

  account() {
    try {
      return JSON.parse(store.getSecret(SECRET_KEY) || 'null');
    } catch {
      return null;
    }
  }

  save(acc) {
    store.setSecret(SECRET_KEY, acc ? JSON.stringify(acc) : null);
  }

  status() {
    const a = this.account();
    return {
      signedIn: !!(a && a.refreshToken),
      email: a ? a.email : null,
      name: a ? a.name : null,
      planUsage: !!(a && (a.scope || '').split(' ').includes(PLAN_SCOPE)),
      welcomed: !!(a && a.welcomed),
      known: !!(a && a.clientId),
    };
  }

  markWelcomed() {
    const a = this.account();
    if (a) this.save({ ...a, welcomed: true });
  }

  cancel() {
    if (this.pending) this.pending.cancel();
  }

  // Öffnet den Login im Standardbrowser und wartet auf den Rückruf an 127.0.0.1.
  // Liefert der Code-Tausch invalid_grant, wird – wie von OpenAI empfohlen – mit der bereits
  // vergebenen client_id einmal automatisch neu autorisiert.
  async login({ switchAccount = false } = {}) {
    this.cancel();
    let prev = switchAccount ? null : this.account();
    log(`Login gestartet (switchAccount=${switchAccount}, gespeicherte client_id=${prev && prev.clientId ? mask(prev.clientId) : 'keine'})`);
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await this.authorizeOnce(prev, attempt);
      } catch (e) {
        log(`Versuch ${attempt} fehlgeschlagen: ${e.code || ''} ${e.message}`);
        if (e.code === 'invalid_grant' && attempt === 2) {
          throw Object.assign(new Error('OpenAI hat die Anmeldung abgelehnt (invalid_grant). Bitte noch einmal versuchen – Details stehen im Protokoll (Einstellungen → KI-Assistent).'), { code: 'invalid_grant' });
        }
        if (e.code !== 'invalid_grant') throw e;
        prev = this.account(); // enthält jetzt die vergebene client_id
      }
    }
  }

  async authorizeOnce(prev, attempt) {
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(24));
    const nonce = b64url(crypto.randomBytes(24));
    const server = await listen();
    const redirectUri = `http://127.0.0.1:${server.address().port}${CALLBACK_PATH}`;
    const reuse = !!(prev && prev.clientId);

    const params = new URLSearchParams({
      client_id: reuse ? prev.clientId : 'dynamic_agent_client',
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: SCOPES,
      resource: RESOURCE,
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      ext_agent_host_id: this.hostId(),
    });
    if (reuse) {
      if (prev.idToken) params.set('id_token_hint', prev.idToken);
      if (prev.email) params.set('login_hint', prev.email);
    } else {
      params.set('agent_name_hint', APP_NAME);
    }
    log(`Versuch ${attempt}: autorisiere mit ${reuse ? 'vergebener client_id ' + mask(prev.clientId) : 'dynamic_agent_client (neue Registrierung)'}, redirect_uri=${redirectUri}`);

    const callback = await new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => finish(new Error('Zeitüberschreitung bei der Anmeldung')), 5 * 60 * 1000);
      const finish = (err, val) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.pending = null;
        setTimeout(() => server.close(), 500);
        err ? reject(err) : resolve(val);
      };
      this.pending = { cancel: () => finish(Object.assign(new Error('Anmeldung abgebrochen'), { code: 'cancelled' })) };
      server.on('request', (req, res) => {
        const u = new URL(req.url, redirectUri);
        if (u.pathname !== CALLBACK_PATH || done) {
          res.writeHead(404);
          return res.end();
        }
        const q = Object.fromEntries(u.searchParams);
        log(`Rückruf erhalten: ${Object.keys(q).join(', ')}${q.error ? ' error=' + q.error : ''}`);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (q.error) {
          res.end(page('Anmeldung nicht abgeschlossen', 'Du kannst dieses Fenster schließen und es in Moodle Desktop erneut versuchen.', false));
          return finish(Object.assign(new Error(q.error_description || q.error), { code: q.error }));
        }
        if (q.state !== state || !q.code) {
          res.end(page('Anmeldung fehlgeschlagen', 'Ungültige Antwort. Bitte erneut versuchen.', false));
          return finish(new Error('Ungültiger OAuth-Rückruf'));
        }
        res.end(page('Mit ChatGPT verbunden', 'Du kannst dieses Fenster schließen und zu Moodle Desktop zurückkehren.'));
        finish(null, q);
      });
      shell.openExternal(`${AUTH_URL}?${params}`);
    });

    // Neue Registrierung liefert die vergebene client_id im Rückruf – niemals dynamic_agent_client speichern
    const clientId = callback.client_id && callback.client_id !== 'dynamic_agent_client' ? callback.client_id : reuse ? prev.clientId : null;
    if (!clientId) throw new Error('Keine client_id von OpenAI erhalten');
    if (!reuse || clientId !== prev.clientId) {
      // Registrierung sofort sichern, damit ein erneuter Versuch dieselbe client_id nutzt
      this.save({ clientId, hostId: this.hostId() });
      log(`Neue client_id gespeichert: ${mask(clientId)}`);
    }

    const form = { grant_type: 'authorization_code', client_id: clientId, code: callback.code, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE };
    let tok;
    try {
      tok = await this.tokenRequest(form);
    } catch (e) {
      log(`Code-Tausch mit ${mask(clientId)} fehlgeschlagen: ${e.code || ''} ${e.message}`);
      throw e;
    }
    log(`Tokens erhalten (scope=${tok.scope || callback.scope || '–'}, expires_in=${tok.expires_in})`);
    const claims = await verifyIdToken(tok.id_token, { clientId, nonce });
    const scope = tok.scope || callback.scope || '';
    const acc = {
      clientId,
      sub: claims.sub,
      email: claims.email || null,
      name: claims.name || claims.email || null,
      idToken: tok.id_token,
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      expiresAt: Date.now() + (tok.expires_in || 3600) * 1000,
      scope,
      welcomed: !!(prev && prev.sub === claims.sub && prev.welcomed),
    };
    this.save(acc);
    if (!scope.split(' ').includes(PLAN_SCOPE)) {
      const e = new Error('Die Nutzung deines ChatGPT-Plans wurde nicht freigegeben (oder dein Plan ist dafür nicht berechtigt).');
      e.code = 'no_plan_scope';
      throw e;
    }
    log('Login erfolgreich');
    return this.status();
  }

  async tokenRequest(form) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(form),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(data.error_description || data.error || `Token-Anfrage fehlgeschlagen (HTTP ${res.status})`);
      e.code = data.error;
      throw e;
    }
    return data;
  }

  // Gültiges Access-Token (wird bei Bedarf – serialisiert – erneuert)
  async accessToken() {
    const a = this.account();
    if (!a || !a.refreshToken) throw new AuthRequiredError('Nicht mit ChatGPT angemeldet.');
    if (a.accessToken && a.expiresAt - 120000 > Date.now()) return a.accessToken;
    if (!this.refreshing) {
      this.refreshing = (async () => {
        try {
          const tok = await this.tokenRequest({ grant_type: 'refresh_token', client_id: a.clientId, refresh_token: a.refreshToken, resource: RESOURCE });
          const next = {
            ...a,
            accessToken: tok.access_token,
            refreshToken: tok.refresh_token || a.refreshToken,
            idToken: tok.id_token || a.idToken,
            expiresAt: Date.now() + (tok.expires_in || 3600) * 1000,
            scope: tok.scope || a.scope,
          };
          this.save(next);
          return next.accessToken;
        } catch (e) {
          log(`Token-Erneuerung fehlgeschlagen: ${e.code || ''} ${e.message}`);
          if (REFRESH_FAIL.has(e.code)) {
            this.save({ ...a, accessToken: null, refreshToken: null });
            throw new AuthRequiredError('Deine ChatGPT-Anmeldung ist abgelaufen – bitte erneut anmelden.');
          }
          throw e;
        } finally {
          this.refreshing = null;
        }
      })();
    }
    return this.refreshing;
  }

  // Abmelden: Refresh-Token widerrufen, Registrierung (client_id) für die nächste Anmeldung behalten
  async logout({ forget = false } = {}) {
    this.cancel();
    const a = this.account();
    if (a && a.refreshToken) {
      try {
        const { revocation_endpoint } = await oidc();
        if (revocation_endpoint) {
          await fetch(revocation_endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: a.refreshToken, token_type_hint: 'refresh_token', client_id: a.clientId }),
          });
        }
      } catch {}
    }
    if (forget || !a) this.save(null);
    else this.save({ clientId: a.clientId, sub: a.sub, email: a.email, name: a.name, idToken: a.idToken, welcomed: a.welcomed });
    return this.status();
  }
}

module.exports = { ChatGPTAuth, AuthRequiredError, log, LOG_FILE };
