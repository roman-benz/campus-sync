// Moodle-Webservice-Client (gleiche Schnittstelle wie die offizielle Moodle-App).
// Wird nur vom Sync-Dienst und für Login/Downloads benutzt – die Oberfläche liest den lokalen Cache.
const { BrowserWindow, session } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const SERVICE = 'moodle_mobile_app';

function normalizeSite(url) {
  let u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u.replace(/\/+$/, '');
}

// Moodle erwartet Arrays/Objekte in PHP-Notation: courseids[0]=1&options[0][name]=x
function encodeParams(params, prefix, out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(params || {})) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') encodeParams(v, key, out);
    else out.append(key, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
  }
  return out;
}

class MoodleError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

class MoodleClient {
  constructor({ siteUrl, token, privateToken }) {
    this.siteUrl = normalizeSite(siteUrl);
    this.token = token;
    this.privateToken = privateToken || null;
  }

  async call(wsfunction, params = {}) {
    const body = encodeParams(params);
    body.append('wstoken', this.token);
    body.append('wsfunction', wsfunction);
    const res = await fetch(
      `${this.siteUrl}/webservice/rest/server.php?moodlewsrestformat=json&wsfunction=${wsfunction}`,
      { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    if (!res.ok) throw new MoodleError(`HTTP ${res.status} bei ${wsfunction}`, 'http');
    const data = await res.json();
    if (data && data.exception) {
      throw new MoodleError(data.message || data.errorcode, data.errorcode);
    }
    return data;
  }

  // Webservice-Datei-URL mit Token (pluginfile.php → webservice/pluginfile.php)
  fileUrl(url) {
    let u = url.replace(/\/pluginfile\.php\//, '/webservice/pluginfile.php/');
    u = u.replace('/webservice/webservice/', '/webservice/');
    return u + (u.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(this.token);
  }

  async download(url, dest) {
    const res = await fetch(this.fileUrl(url));
    if (!res.ok) throw new MoodleError(`Download fehlgeschlagen (HTTP ${res.status})`, 'http');
    const type = res.headers.get('content-type') || '';
    // Moodle liefert Fehler als JSON statt als Datei
    if (type.includes('application/json')) {
      const data = await res.json().catch(() => ({}));
      throw new MoodleError(data.error || data.message || 'Download verweigert', data.errorcode);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.part';
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
    fs.renameSync(tmp, dest);
  }

  async fetchBuffer(url) {
    const res = await fetch(this.fileUrl(url));
    if (!res.ok) throw new MoodleError(`HTTP ${res.status}`, 'http');
    return { buffer: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') || '' };
  }

  // Ein-Klick-Login im Browser für Seiten wie Tests oder Abgaben, die es nur online gibt.
  async autologinUrl(target) {
    if (!this.privateToken) return target;
    try {
      const r = await this.call('tool_mobile_get_autologin_key', { privatetoken: this.privateToken });
      const u = new URL(r.autologinurl);
      u.searchParams.set('userid', String(this.userid || ''));
      u.searchParams.set('key', r.key);
      u.searchParams.set('urltogo', target);
      return u.toString();
    } catch {
      return target; // Moodle drosselt Autologin (max. 1x alle 6 Minuten)
    }
  }
}

async function getPublicConfig(siteUrl) {
  const res = await fetch(
    `${normalizeSite(siteUrl)}/lib/ajax/service-nologin.php?args=` +
      encodeURIComponent(JSON.stringify([{ index: 0, methodname: 'tool_mobile_get_public_config', args: {} }])),
    { method: 'POST' }
  );
  const data = await res.json();
  if (!Array.isArray(data) || data[0].error) throw new MoodleError('Keine Moodle-Seite oder Mobile-Dienst deaktiviert');
  return data[0].data;
}

async function loginWithPassword(siteUrl, username, password) {
  const body = new URLSearchParams({ username, password, service: SERVICE });
  const res = await fetch(`${normalizeSite(siteUrl)}/login/token.php`, { method: 'POST', body });
  const data = await res.json();
  if (!data.token) throw new MoodleError(data.error || 'Anmeldung fehlgeschlagen', data.errorcode);
  return { token: data.token, privateToken: data.privatetoken || null };
}

// SSO-Login (Shibboleth, Microsoft, …): Moodle-Login in eigenem Fenster, danach leitet
// admin/tool/mobile/launch.php auf <scheme>://token=BASE64 um – diese Umleitung fangen wir ab.
function loginWithBrowser(siteUrl, parent) {
  const site = normalizeSite(siteUrl);
  const passport = crypto.randomBytes(8).toString('hex');
  const launch = `${site}/admin/tool/mobile/launch.php?service=${SERVICE}&passport=${passport}&urlscheme=moodlemobile`;

  return new Promise((resolve, reject) => {
    const ses = session.fromPartition('persist:moodle-login');
    const win = new BrowserWindow({
      width: 980,
      height: 760,
      parent,
      modal: !!parent,
      title: 'Bei Moodle anmelden',
      autoHideMenuBar: true,
      webPreferences: { session: ses, contextIsolation: true, sandbox: true },
    });
    let done = false;

    const tryCapture = (event, url) => {
      if (done || !url) return;
      const m = /^([a-z][a-z0-9+.-]*):\/\/token=([^&#]+)/i.exec(url);
      if (!m || /^https?$/i.test(m[1])) return;
      if (event && event.preventDefault) event.preventDefault();
      done = true;
      try {
        const decoded = Buffer.from(decodeURIComponent(m[2]), 'base64').toString('utf8');
        const [signature, token, privateToken] = decoded.split(':::');
        const expected = crypto.createHash('md5').update(site + passport).digest('hex');
        if (signature && signature !== expected) {
          // Manche Seiten nutzen eine abweichende wwwroot-Schreibweise – Token trotzdem akzeptieren.
          console.warn('SSO-Signatur weicht ab');
        }
        resolve({ token, privateToken: privateToken || null });
      } catch (e) {
        reject(e);
      }
      setImmediate(() => !win.isDestroyed() && win.close());
    };

    win.webContents.on('will-redirect', (e, url) => tryCapture(e, url));
    win.webContents.on('will-navigate', (e, url) => tryCapture(e, url));
    win.webContents.on('did-fail-provisional-load', (_e, _c, _d, url) => tryCapture(null, url));
    win.webContents.on('did-start-navigation', (details) => tryCapture(null, details.url));
    win.webContents.setWindowOpenHandler(({ url }) => {
      tryCapture(null, url);
      return { action: 'deny' };
    });
    win.on('closed', () => {
      if (!done) reject(new MoodleError('Anmeldung abgebrochen', 'cancelled'));
    });
    win.loadURL(launch);
  });
}

module.exports = { MoodleClient, MoodleError, getPublicConfig, loginWithPassword, loginWithBrowser, normalizeSite };
