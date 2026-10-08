// Zugang zur Desktop-App mit demselben Passkey wie auf chadoodle.romanbenz.com.
// Anmeldung im Standardbrowser (/app-login, Passkey) → Einmal-Code an 127.0.0.1 → Tausch gegen ein
// Sitzungstoken (PKCE). Das Token liegt verschlüsselt (DPAPI) in secrets.json; widerruft der Admin die
// Sitzung oder löscht den Nutzer, sperrt sich die App bei der nächsten Prüfung.
const { shell } = require('electron');
const { EventEmitter } = require('events');
const http = require('http');
const crypto = require('crypto');
const store = require('./store');

// Nur für Tests/Entwicklung überschreibbar
const BASE = (process.env.CHADOODLE_WEB_URL || 'https://chadoodle.romanbenz.com').replace(/\/+$/, '');
const SECRET_KEY = 'webSession';
const CALLBACK_PATH = '/callback';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const page = (title, text, ok = true) => `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:"Segoe UI",system-ui,sans-serif;background:#f4f6f9;color:#1d2125;display:grid;place-items:center;height:100vh;margin:0}
.c{background:#fff;border:1px solid #e2e6ec;border-radius:18px;padding:32px 36px;max-width:420px;text-align:center;box-shadow:0 12px 40px rgba(16,24,40,.12)}
.i{width:52px;height:52px;border-radius:50%;margin:0 auto 14px;display:grid;place-items:center;font-size:26px;color:#fff;background:${ok ? '#357a32' : '#ca3120'}}
h1{font-size:20px;margin:0 0 6px}p{color:#5f6871;margin:0}</style></head>
<body><div class="c"><div class="i">${ok ? '✓' : '!'}</div><h1>${title}</h1><p>${text}</p></div></body></html>`;

async function api(path, { token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.error || `Fehler ${res.status}`), { status: res.status });
  return j;
}

class WebAccess extends EventEmitter {
  constructor() {
    super();
    this.pending = null;
  }

  session() {
    try {
      return JSON.parse(store.getSecret(SECRET_KEY) || 'null');
    } catch {
      return null;
    }
  }

  save(s) {
    store.setSecret(SECRET_KEY, s ? JSON.stringify(s) : null);
    this.emit('status', this.status());
  }

  get signedIn() {
    const s = this.session();
    return !!(s && s.token);
  }

  status() {
    const s = this.session();
    return { signedIn: !!(s && s.token), user: s ? s.user : null, pending: !!this.pending, base: BASE };
  }

  // Sitzung beim Server prüfen. Ohne Netz bleibt die App offen (offline nutzbar);
  // nur eine klare Absage des Servers (401) sperrt sie.
  async check() {
    const s = this.session();
    if (!s || !s.token) return false;
    try {
      const { user } = await api('/api/auth/me', { token: s.token });
      if (JSON.stringify(user) !== JSON.stringify(s.user)) this.save({ ...s, user });
      return true;
    } catch (e) {
      if (e.status === 401) {
        this.save(null);
        return false;
      }
      return true;
    }
  }

  cancel() {
    if (this.pending) this.pending.cancel();
  }

  async login() {
    this.cancel();
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(24));
    const server = await new Promise((resolve, reject) => {
      const srv = http.createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const port = server.address().port;
    const shutdown = () => {
      server.close();
      server.closeAllConnections();
    };

    try {
      const code = await new Promise((resolve, reject) => {
        let done = false;
        const finish = (err, val) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          this.pending = null;
          this.emit('status', this.status());
          err ? reject(err) : resolve(val);
        };
        const timer = setTimeout(() => finish(Object.assign(new Error('Zeitüberschreitung bei der Anmeldung'), { code: 'timeout' })), 10 * 60 * 1000);
        this.pending = { cancel: () => finish(Object.assign(new Error('Anmeldung abgebrochen'), { code: 'cancelled' })) };
        server.on('request', (req, res) => {
          const u = new URL(req.url, `http://127.0.0.1:${port}`);
          if (u.pathname !== CALLBACK_PATH || done) {
            res.writeHead(404, { Connection: 'close' });
            return res.end();
          }
          // Falscher state: nicht unser Anmeldevorgang (z. B. ein alter Tab) → ignorieren
          if (u.searchParams.get('state') !== state || !u.searchParams.get('code')) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
            return res.end(page('Anmeldung fehlgeschlagen', 'Bitte die Anmeldung in der App neu starten.', false));
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
          res.end(page('Angemeldet', 'Die Chadoodle-App ist jetzt angemeldet. Du kannst diesen Tab schließen.'));
          finish(null, u.searchParams.get('code'));
        });
        this.emit('status', this.status());
        shell.openExternal(`${BASE}/app-login#${new URLSearchParams({ port: String(port), state, challenge })}`);
      });
      const { token, user } = await api('/api/auth/app/token', { body: { code, verifier } });
      this.save({ token, user });
      return this.status();
    } finally {
      shutdown();
    }
  }

  async logout() {
    const s = this.session();
    this.save(null);
    if (s && s.token) await api('/api/auth/logout', { token: s.token, body: {} }).catch(() => {});
    return this.status();
  }
}

module.exports = { WebAccess, WEB_BASE: BASE };
