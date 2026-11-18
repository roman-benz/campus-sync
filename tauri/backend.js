// Tauri-Version von Chadoodle: übernimmt die Rolle von src/main/main.js (Hauptprozess) und
// src/preload.js (window.api). Die Module aus src/main laufen unverändert; Node und Electron
// ersetzen die Shims in tauri/shims, die Betriebssystem-Arbeit macht Rust (src-tauri).
require('./net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { shell } = require('electron');
const store = require('../src/main/store');
const { MoodleClient, MoodleError, getPublicConfig, loginWithPassword, prepareBrowserLogin, parseLaunchToken, normalizeSite } = require('../src/main/moodle');
const { SyncEngine, media } = require('../src/main/sync');
const { ClaudeAssistant } = require('../src/main/claude');
const { ChatGPTAssistant } = require('../src/main/chatgpt');
const chatgptAuthModule = require('../src/main/chatgpt-auth');
const { DocIndex } = require('./docindex');
const { AiTools } = require('../src/main/ai-tools');
const { Timetables, RAPLA_TEMPLATE } = require('../src/main/timetable');
const { Mensa, DEFAULT_URL: MENSA_DEFAULT } = require('../src/main/mensa');
const { Account } = require('../src/main/account');
const { WebAccess } = require('../src/main/web-access');
const { Dualis } = require('../src/main/dualis');
const { Updater } = require('./updater');

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const ENV = window.__CHADOODLE__;
const APP_NAME = 'Chadoodle';
const HIDDEN_FLAG = store.file('start-hidden');
const startHidden = ENV.startHidden;
const call = (cmd, args) => invoke(cmd, args).catch((e) => console.warn(cmd, e));

// ---------- Anpassungen der gemeinsamen Module ----------
// Downloads schreibt Rust direkt auf die Platte (kein Umweg über den Speicher der Oberfläche)
MoodleClient.prototype.download = async function (url, dest) {
  let r;
  try {
    r = await invoke('download', { url: this.fileUrl(url), dest: String(dest) });
  } catch (e) {
    throw Object.assign(new TypeError('fetch failed'), { cause: new Error(String(e)) });
  }
  if (r.ok) return;
  if (r.status >= 200 && r.status < 300) {
    let data = {};
    try {
      data = JSON.parse(r.body);
    } catch {}
    throw new MoodleError(data.error || data.message || 'Download verweigert', data.errorcode);
  }
  throw new MoodleError(`Download fehlgeschlagen (HTTP ${r.status})`, 'http');
};

// SSO-Login im eigenen Fenster; Rust fängt die Umleitung auf moodlemobile://token=… ab
async function loginWithBrowser(siteUrl) {
  const { launch, valid } = await prepareBrowserLogin(siteUrl);
  let url;
  try {
    url = await invoke('moodle_login_window', { launch });
  } catch {
    throw new MoodleError('Anmeldung abgebrochen', 'cancelled');
  }
  return parseLaunchToken(url, valid);
}

// Bilder/Dateien aus Moodle-Texten liefert das eigene Protokoll unter /mfile/… (src-tauri/src/protocol.rs)
media.prefix = '/mfile/';

// ---------- Ereignisse an die Oberfläche ----------
const listeners = new Map();
const clone = (v) => (v === undefined ? v : structuredClone(v));
function send(channel, data) {
  for (const fn of listeners.get(channel) || []) {
    try {
      fn(clone(data));
    } catch (e) {
      console.error(e);
    }
  }
}
const on = (channel) => (cb) => {
  if (!listeners.has(channel)) listeners.set(channel, new Set());
  listeners.get(channel).add(cb);
  return () => listeners.get(channel).delete(cb);
};

// ---------- Dienste (wie in main.js) ----------
const sync = new SyncEngine();
const docIndex = new DocIndex(sync);
const aiTools = new AiTools(sync, docIndex);
const timetables = new Timetables();
const mensa = new Mensa();
const account = new Account(mensa);
// Noten aus Dualis (Zugangsdaten verschlüsselt auf diesem PC)
const dualis = new Dualis();
// Zugang zur App nur mit Passkey (wie auf der Website)
const webAccess = new WebAccess();
aiTools.timetables = timetables;
aiTools.mensa = mensa;
aiTools.dualis = dualis;
// Nur Entwicklung: Zugriff für automatische Tests (tauri/test, tauri/cdp.mjs)
if (!ENV.packaged) window.__chadoodleDebug = { docIndex, sync, aiTools };
aiTools.onPrepareCart = (cart) => send('mensa:prepare', cart);
aiTools.onOrdered = (entry) => send('mensa:ordered', entry);
// Bestellungen des Assistenten bestätigt der Nutzer im Fenster; ohne Antwort binnen 10 Min. = abgelehnt
const orderConfirms = new Map();
aiTools.confirmOrder = (summary) =>
  new Promise((resolve) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => orderConfirms.delete(id) && resolve(false), 10 * 60 * 1000);
    orderConfirms.set(id, (ok) => {
      clearTimeout(timer);
      resolve(ok);
    });
    showWindow();
    send('mensa:confirm', { id, ...summary });
  });
const claude = new ClaudeAssistant(aiTools);
const chatgptAuth = new chatgptAuthModule.ChatGPTAuth();
const chatgpt = new ChatGPTAssistant(aiTools, chatgptAuth);
const assistant = (provider) => (provider === 'chatgpt' ? chatgpt : claude);

let windowVisible = !startHidden;
const updater = new Updater({
  canRestartSilently: () => !windowVisible && !sync.running && !claude.isBusy() && !chatgpt.isBusy() && !docIndex.busy,
  beforeInstall: ({ hidden }) => {
    if (hidden) fs.writeFileSync(HIDDEN_FLAG, '1');
    if (sync.cache) sync.save();
  },
});

// ---------- Fenster, Tray, Betriebssystem ----------
function showWindow() {
  windowVisible = true;
  call('win_show');
  afterShow();
}

// Beim Öffnen nachsynchronisieren, falls der letzte Sync länger her ist
function afterShow() {
  windowVisible = true;
  const interval = Math.max(5, Number(store.getSettings().syncIntervalMin) || 30) * 60 * 1000;
  if (sync.client && sync.cache && Date.now() - sync.cache.lastSync > interval) sync.run();
  account.pull();
  checkAccess();
}

function hideWindow() {
  windowVisible = false;
  call('win_hide');
}

function quit() {
  call('app_quit');
}

function refreshTray(s = sync.status) {
  const state = s && s.state === 'idle' ? 'synchronisiert' : (s && s.message) || '';
  call('tray_update', { tooltip: `${APP_NAME} ${ENV.version}${state ? ' – ' + state : ''}`, canSync: !!sync.client });
}

function applyTheme(theme) {
  call('set_theme', { theme: theme || 'system' });
}

function applyLoginItem() {
  call('set_login_item', { enabled: !!store.getSettings().startWithWindows });
}

// Aus welchen Ordnern die Oberfläche lokale Dateien anzeigen darf (/vfs/…)
function applyRoots() {
  call('set_allowed_dirs', { dirs: [store.getSettings().downloadDir, store.file(path.join('cache', 'img'))].map((d) => String(d).replace(/\//g, '\\')) });
}

// Token für /mfile/ (Moodle-Medien) – nur solange der Sync-Dienst angemeldet ist
function applyMedia() {
  const c = sync.client;
  call('set_media', c ? { siteUrl: c.siteUrl, token: c.token } : { siteUrl: null, token: null });
}

// opts.important: bleibt stehen, bis man sie wegklickt; opts.route: Bereich, den ein Klick öffnet
function notify(title, body, opts = {}) {
  call('notify', { title, body: body || '', important: !!opts.important, route: opts.route || null, button: opts.button || null });
}

async function openExternal(url) {
  if (!/^https?:\/\//i.test(url)) return;
  // Moodle-Seiten mit automatischer Anmeldung öffnen (wenn möglich)
  if (sync.client && sync.client.isSiteUrl(url)) url = await sync.client.autologinUrl(url);
  shell.openExternal(url);
}

// Passkey-Sitzung prüfen (höchstens alle 10 Min.); vom Admin widerrufen → App sperren
let lastAccessCheck = 0;
async function checkAccess(force = false) {
  if (!webAccess.signedIn || (!force && Date.now() - lastAccessCheck < 10 * 60 * 1000)) return;
  lastAccessCheck = Date.now();
  if (!(await webAccess.check())) lockApp();
}

// Sync anhalten; Moodle-Anmeldung und Dateien bleiben, nach der nächsten Passkey-Anmeldung geht es weiter
function lockApp() {
  if (sync.client) {
    sync.save();
    sync.detach();
  }
  applyMedia();
  refreshTray();
  send('gate:status', webAccess.status());
}

function startSession() {
  if (!webAccess.signedIn) return false;
  const s = store.getSettings();
  const token = store.getSecret('moodleToken');
  if (!token || !s.siteUrl) return false;
  const client = new MoodleClient({ siteUrl: s.siteUrl, token, privateToken: store.getSecret('moodlePrivateToken') });
  sync.attach(client);
  sync.startTimer();
  applyMedia();
  refreshTray();
  setTimeout(() => sync.run(), 1500);
  return true;
}

// Leere Unterordner (und den Ordner selbst, falls dann leer) entfernen
function removeEmptyDirs(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) if (e.isDirectory()) removeEmptyDirs(path.join(dir, e.name));
  try {
    if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
  } catch {}
}

// Der Cache einer Electron-Installation enthält mfile://- und file://-Adressen; die Oberfläche
// der Tauri-Version lädt dieselben Dateien über /mfile/ und /vfs/ (bis der nächste Sync sie ersetzt)
function forUi(cache) {
  if (!cache) return cache;
  let s = JSON.stringify(cache);
  if (s.includes('mfile://file/') || s.includes('file:///')) {
    s = s.replaceAll('mfile://file/', '/mfile/').replace(/file:\/\/\/([A-Za-z]:[^"?#\\]*)/g, (m, p) => {
      try {
        return '/vfs/' + p.split('/').map((seg) => encodeURIComponent(decodeURIComponent(seg))).join('/');
      } catch {
        return m;
      }
    });
  }
  return JSON.parse(s);
}

// ---------- Handler (gleiche Namen/Verhalten wie die IPC-Kanäle in main.js) ----------
const handlers = {
  state: () => ({
    gate: webAccess.status(),
    loggedIn: !!sync.client,
    settings: store.getSettings(),
    hasClaudeKey: !!store.getSecret('anthropicKey'),
    account: account.status,
    version: ENV.version,
    update: updater.status,
    chatgpt: chatgptAuth.status(),
    index: sync.client ? docIndex.status() : null,
    status: sync.status,
  }),
  data: () => (webAccess.signedIn ? forUi(sync.cache) : null),

  // Passkey-Zugang zur App
  async gateLogin() {
    const st = await webAccess.login();
    lastAccessCheck = Date.now();
    if (startSession()) setTimeout(() => docIndex.indexPending(), 8000);
    showWindow();
    return st;
  },
  gateCancel: () => webAccess.cancel(),
  async gateLogout() {
    await webAccess.logout();
    lockApp();
    return webAccess.status();
  },

  async checkSite(url) {
    const cfg = await getPublicConfig(url);
    return {
      sitename: cfg.sitename,
      typeoflogin: cfg.typeoflogin, // 1 = App, 2 = Browser, 3 = eingebetteter Browser
      identityproviders: (cfg.identityproviders || []).map((p) => p.name),
      logourl: cfg.logourl || cfg.compactlogourl || null,
      url: normalizeSite(url),
    };
  },
  async login({ siteUrl, username, password, sso }) {
    if (!webAccess.signedIn) throw new Error('Bitte zuerst mit Passkey anmelden.');
    const site = normalizeSite(siteUrl);
    const result = sso ? await loginWithBrowser(site) : await loginWithPassword(site, username, password);
    store.setSettings({ siteUrl: site });
    store.setSecret('moodleToken', result.token);
    store.setSecret('moodlePrivateToken', result.privateToken);
    startSession();
    // Chadoodle-Konto verbinden (läuft im Hintergrund; ohne Netz klappt es beim nächsten Start)
    account.login(site, result.token).catch((e) => account.setStatus('error', e.message));
    return true;
  },
  async logout({ deleteFiles }) {
    // Nur die synchronisierten Dateien löschen, nie den ganzen Ordner (kann frei gewählt sein)
    const files = deleteFiles && sync.cache ? Object.values(sync.cache.files).map((f) => f.localPath) : [];
    const courseDirs = deleteFiles && sync.cache ? sync.cache.courses.map((k) => sync.courseDir(k)) : [];
    sync.detach();
    applyMedia();
    refreshTray();
    await account.logout();
    store.setSecret('moodleToken', null);
    store.setSecret('moodlePrivateToken', null);
    for (const f of files) fs.rmSync(f, { force: true });
    for (const d of courseDirs) removeEmptyDirs(d);
    return true;
  },
  sync() {
    sync.run();
    return true;
  },
  setSettings(patch) {
    const before = store.getSettings();
    const s = store.setSettings(patch);
    if (patch.syncIntervalMin && sync.client) sync.startTimer();
    if ('startWithWindows' in patch) applyLoginItem();
    if (patch.theme) applyTheme(patch.theme);
    if (patch.downloadDir && patch.downloadDir !== before.downloadDir) {
      applyRoots();
      if (sync.cache) {
        // Neuer Ordner → Pfade neu berechnen und Dateien neu laden
        sync.cache.files = {};
        sync.save();
        sync.run();
      }
    }
    return s;
  },
  setClaudeKey(key) {
    store.setSecret('anthropicKey', key || null);
    account.keyChanged(key || null);
    return true;
  },

  // Chadoodle-Konto
  async accountConnect() {
    const token = store.getSecret('moodleToken');
    if (!token) throw new Error('Bitte zuerst bei Moodle anmelden.');
    await account.login(store.getSettings().siteUrl, token);
    return account.status;
  },
  async accountDisconnect() {
    await account.logout({ disable: true });
    return account.status;
  },
  async accountDelete() {
    await account.deleteAccount();
    return account.status;
  },
  async accountSync() {
    await account.pull();
    return account.status;
  },

  pickFolder: () => invoke('pick_folder', { defaultPath: String(store.getSettings().downloadDir || '').replace(/\//g, '\\') }),
  async openFile(id) {
    const f = await sync.ensureFile(id);
    const err = await shell.openPath(f.localPath);
    if (err) throw new Error(err);
    return true;
  },
  async showFile(id) {
    const f = await sync.ensureFile(id);
    shell.showItemInFolder(f.localPath);
    return true;
  },
  async fileUrl(id) {
    const f = await sync.ensureFile(id);
    return require('url').pathToFileURL(f.localPath).href;
  },
  openFolder(courseId) {
    let dir = store.getSettings().downloadDir;
    if (courseId && sync.cache) {
      const k = sync.cache.courses.find((c) => c.id === courseId);
      if (k) dir = sync.courseDir(k);
    }
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
  },
  openExternal: (url) => openExternal(url),
  // Fertige Mail im Standard-Mailprogramm öffnen (Verschiebevorschlag im Stundenplan)
  openMail(url) {
    if (typeof url === 'string' && /^mailto:/i.test(url)) return shell.openExternal(url);
  },
  clearNews() {
    if (sync.cache) {
      sync.cache.newItems = [];
      sync.save();
    }
  },

  aiSend(payload) {
    assistant(payload.provider).send(payload, (type, data) => send('ai:event', { conversationId: payload.conversationId, type, ...data }));
    return true;
  },
  aiStop: (provider, id) => assistant(provider).stop(id),
  aiReset: (provider, id) => assistant(provider).reset(id),

  // ChatGPT-Anmeldung (Plan-Nutzung)
  chatgptStatus: () => chatgptAuth.status(),
  async chatgptLogin(opts) {
    const st = await chatgptAuth.login(opts || {});
    chatgpt.modelCache = null;
    showWindow();
    return st;
  },
  chatgptCancel: () => chatgptAuth.cancel(),
  chatgptLogout: (opts) => chatgptAuth.logout(opts || {}),
  chatgptModels: (force) => chatgpt.models(!!force),
  chatgptWelcomed: () => chatgptAuth.markWelcomed(),
  chatgptOpenLog() {
    const f = chatgptAuthModule.LOG_FILE();
    if (fs.existsSync(f)) shell.openPath(f);
    else shell.openPath(path.dirname(path.dirname(f)));
  },

  // Dokumente: Volltextsuche, Seiten, Rohdaten für den PDF-Viewer
  docSearch: (q, opts) => docIndex.search(q, opts || {}),
  docStatus: () => docIndex.status(),
  docPages: (id, from, to) => docIndex.getPages(id, from, to),
  async fileData(id) {
    const f = await sync.ensureFile(id);
    return fs.readFileAsync(f.localPath);
  },

  // Stundenpläne
  ttList: () => ({ list: timetables.list(), active: store.getSettings().timetableActive, template: RAPLA_TEMPLATE }),
  ttEvents: (id, from, to) => timetables.events(id, from, to),
  async ttAdd(t) {
    const added = await timetables.add(t);
    store.setSettings({ timetableActive: added.id });
    return added;
  },
  ttRemove: (id) => timetables.remove(id),
  ttSelect: (id) => store.setSettings({ timetableActive: id }),
  ttRefresh: () => timetables.refreshAll(),

  // Mensa-Speiseplan
  mensaGet: (force) => mensa.get(!!force),
  mensaSetUrl: (url) => mensa.setUrl(url || MENSA_DEFAULT),
  mensaUrl: () => ({ url: mensa.url(), defaultUrl: MENSA_DEFAULT }),
  mensaOrder: () => invoke('mensa_order_window', { url: mensa.url() }),
  mensaOrderOptions: (date, email) => mensa.orderOptions(String(date || ''), String(email || '')),
  mensaPlaceOrder: (o) => mensa.order(o || {}),
  mensaOrders: () => mensa.orders(),
  mensaConfirmReply(id, ok) {
    const done = orderConfirms.get(id);
    if (!done) return false;
    orderConfirms.delete(id);
    done(ok === true);
    return true;
  },

  // Dualis-Noten
  dualisStatus: () => dualis.status(),
  dualisLogin: (user, pass) => dualis.setCredentials(user, pass),
  dualisLogout: () => dualis.removeCredentials(),
  dualisRefresh: () => dualis.refresh(),

  updateStatus: () => updater.status,
  updateCheck: () => updater.check(),
  updateInstall: () => updater.installNow(),
};

// ---------- Start (wie app.whenReady in main.js) ----------
const ready = (async () => {
  applyTheme(store.getSettings().theme);
  applyLoginItem();
  applyRoots();

  sync.on('status', (s) => {
    send('sync:status', s);
    refreshTray(s);
  });
  sync.on('updated', () => send('data:updated'));
  sync.on('files', () => {
    send('data:files');
    docIndex.indexPending();
  });
  docIndex.on('progress', (st) => send('index:status', st));
  sync.on('invalidtoken', () => send('auth:expired'));
  sync.on('notify', (n) => notify(n.title, n.body));

  timetables.on('changed', () => send('tt:changed'));
  timetables.start();
  mensa.on('changed', () => send('mensa:changed'));
  mensa.start();
  dualis.on('changed', () => send('dualis:changed'));
  dualis.on('notify', (n) => store.getSettings().notifications && notify(n.title, n.body, { important: true, route: 'grades', button: n.button }));
  dualis.start();

  // Änderungen von anderen Geräten (Chadoodle-Konto) anwenden
  account.on('status', (st) => send('account:status', st));
  account.on('changed', (c) => {
    const s = c.settings || {};
    if (s.theme) applyTheme(s.theme);
    if ('timetables' in s) timetables.refreshAll();
    else if ('timetableActive' in s) send('tt:changed');
    if ('mensaUrl' in s) mensa.fetch().catch(() => {});
    send('account:changed', { settings: Object.keys(s), key: !!c.key, orders: !!c.orders });
  });
  account.start();

  updater.on('status', (st) => send('update:status', st));
  updater.start();

  // Rust → Logik: Fenster/Tray/zweite Instanz/Benachrichtigung
  listen('app:shown', () => afterShow());
  // Klick auf eine Benachrichtigung → passenden Bereich öffnen (z. B. Noten)
  listen('app:navigate', ({ payload }) => send('app:navigate', String(payload)));
  listen('tray:sync', () => sync.run());
  listen('tray:folder', () => shell.openPath(store.getSettings().downloadDir));
  listen('app:open-external', ({ payload }) => openExternal(String(payload)));
  listen('win:close', () => {
    if (store.getSettings().runInBackground && sync.client) {
      hideWindow();
      if (!store.getSettings().trayHintShown) {
        notify(`${APP_NAME} läuft weiter`, 'Die Synchronisation läuft im Hintergrund. Über das Tray-Symbol kannst du die App öffnen oder beenden.');
        store.setSettings({ trayHintShown: true });
      }
    } else quit();
  });

  // Nach Standby/Ruhezustand sofort synchronisieren und nach Updates schauen
  // (ein Minuten-Takt, der plötzlich eine große Lücke hat, heißt: der Rechner hat geschlafen)
  let lastTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    if (now - lastTick > 3 * 60 * 1000) {
      setTimeout(() => {
        sync.run();
        dualis.refresh();
        updater.check();
        chatgptAuth.keepAlive();
        checkAccess(true);
      }, 15000);
    }
    lastTick = now;
  }, 60 * 1000);
  setInterval(() => checkAccess(true), 6 * 60 * 60 * 1000);

  // ChatGPT-Anmeldung regelmäßig erneuern, damit man sich nicht neu anmelden muss
  setTimeout(() => chatgptAuth.keepAlive(), 60 * 1000);
  setInterval(() => chatgptAuth.keepAlive(), 6 * 60 * 60 * 1000);

  // Mit gespeicherter Passkey-Sitzung sofort loslegen (auch offline); geprüft wird im Hintergrund
  const loggedIn = startSession();
  if (loggedIn) setTimeout(() => docIndex.indexPending(), 8000);
  refreshTray();
  checkAccess(true);
  // Autostart ohne Anmeldung ergibt keinen Sinn – dann gar nicht erst im Hintergrund bleiben
  if (startHidden && !loggedIn) quit();
})();

// Wie ein Electron-Fenster ohne Menü: kein Browser-Kontextmenü, kein Neuladen/Drucken per Tastatur
window.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener(
  'keydown',
  (e) => {
    const k = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    if (k === 'f5' || (ctrl && (k === 'r' || k === 'p')) || (ENV.packaged && (k === 'f12' || (ctrl && e.shiftKey && ['i', 'j', 'c'].includes(k))))) e.preventDefault();
  },
  true,
);
// Fenster erst zeigen, wenn die Oberfläche steht (wie „ready-to-show“)
window.addEventListener('load', () => requestAnimationFrame(() => setTimeout(() => call('win_ready'), 30)));

// Gleiche Aufrufform wie preload.js (Ergebnisse als Kopie, wie über IPC)
const api = {};
for (const [name, fn] of Object.entries(handlers)) {
  api[name] = (...args) => ready.then(() => fn(...args)).then((r) => (name === 'fileData' || name === 'data' ? r : clone(r)));
}
Object.assign(api, {
  onGateStatus: on('gate:status'),
  onTimetables: on('tt:changed'),
  onMensa: on('mensa:changed'),
  onDualis: on('dualis:changed'),
  onNavigate: on('app:navigate'),
  onMensaPrepare: on('mensa:prepare'),
  onMensaConfirm: on('mensa:confirm'),
  onMensaOrdered: on('mensa:ordered'),
  onIndexStatus: on('index:status'),
  onSyncStatus: on('sync:status'),
  onDataUpdated: on('data:updated'),
  onFilesUpdated: on('data:files'),
  onAuthExpired: on('auth:expired'),
  onAi: on('ai:event'),
  onUpdateStatus: on('update:status'),
  onAccountStatus: on('account:status'),
  onAccountChanged: on('account:changed'),
});
window.api = api;
