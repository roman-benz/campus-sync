// Moodle-Webservice-Client (gleiche Schnittstelle wie die offizielle Moodle-App).
// Wird nur vom Sync-Dienst und für Login/Downloads benutzt – die Oberfläche liest den lokalen Cache.
const { BrowserWindow, session } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const SERVICE = 'moodle_mobile_app';
const URL_SCHEME = 'moodlemobile';

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

  // Gehört die URL zu dieser Moodle-Seite? Reiner Präfixvergleich reicht nicht
  // (https://moodle.example.de.evil.com beginnt auch mit https://moodle.example.de).
  isSiteUrl(url) {
    try {
      const u = new URL(url);
      const site = new URL(this.siteUrl);
      const base = site.pathname.replace(/\/+$/, '');
      return u.origin === site.origin && (!base || u.pathname === base || u.pathname.startsWith(base + '/'));
    } catch {
      return false;
    }
  }

  // Webservice-Datei-URL mit Token (pluginfile.php → webservice/pluginfile.php).
  // Das Token geht nur an pluginfile-Adressen der eigenen Moodle-Seite, nie an fremde Server.
  fileUrl(url) {
    if (!this.isSiteUrl(url)) throw new MoodleError('Adresse gehört nicht zu dieser Moodle-Seite', 'foreignurl');
    if (!/\/pluginfile\.php\//.test(url)) return url; // z. B. Theme-Bilder: brauchen kein Token
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
    // Eindeutiger Temp-Name: Hintergrund-Download und Öffnen derselben Datei können sich überschneiden
    const tmp = `${dest}.${crypto.randomBytes(4).toString('hex')}.part`;
    try {
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
      fs.renameSync(tmp, dest);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
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
// admin/tool/mobile/launch.php auf moodlemobile://token=BASE64 um – diese Umleitung fangen wir ab.
// Moodle signiert die Antwort mit md5(wwwroot + passport); ohne passende Signatur wird das Token
// verworfen, damit keine fremde Seite im Anmeldefenster ein eigenes Token unterschieben kann.
// Start der Browser-Anmeldung: Adresse von launch.php und die gültigen Signaturen der Antwort
async function prepareBrowserLogin(siteUrl, extra = '') {
  const site = normalizeSite(siteUrl);
  const passport = crypto.randomBytes(16).toString('hex');
  const launch = `${site}/admin/tool/mobile/launch.php?service=${SERVICE}&passport=${passport}&urlscheme=${URL_SCHEME}${extra}`;
  // Die eingegebene Adresse kann von Moodles wwwroot abweichen (http/https, Schreibweise)
  const roots = new Set([site]);
  try {
    const cfg = await getPublicConfig(site);
    for (const r of [cfg.wwwroot, cfg.httpswwwroot]) if (r) roots.add(String(r).replace(/\/+$/, ''));
  } catch {}
  const valid = new Set([...roots].map((r) => crypto.createHash('md5').update(r + passport).digest('hex')));
  return { launch, valid };
}

// moodlemobile://token=BASE64 → { token, privateToken }; null, wenn die Adresse kein Token enthält
function parseLaunchToken(url, valid) {
  const m = new RegExp(`^${URL_SCHEME}://token=([^&#]+)`, 'i').exec(String(url || '').trim());
  if (!m) return null;
  const decoded = Buffer.from(decodeURIComponent(m[1]), 'base64').toString('utf8');
  const [signature, token, privateToken] = decoded.split(':::');
  if (!signature || !valid.has(signature)) throw new MoodleError('Antwort der Anmeldung ist ungültig (Signatur passt nicht). Bitte erneut versuchen.', 'badsignature');
  if (!token) throw new MoodleError('Moodle hat kein Zugriffstoken geliefert.', 'notoken');
  return { token, privateToken: privateToken || null };
}

async function loginWithBrowser(siteUrl, parent) {
  const { launch, valid } = await prepareBrowserLogin(siteUrl);

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
      if (!new RegExp(`^${URL_SCHEME}://token=`, 'i').test(url)) return;
      if (event && event.preventDefault) event.preventDefault();
      done = true;
      try {
        resolve(parseLaunchToken(url, valid));
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

module.exports = { MoodleClient, MoodleError, getPublicConfig, loginWithPassword, loginWithBrowser, prepareBrowserLogin, parseLaunchToken, normalizeSite };
