const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, Notification, nativeImage, protocol, nativeTheme, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
// Eigenes Profil (für Tests/Demo); muss vor allem anderen gesetzt werden
if (process.env.MOODLE_DESKTOP_USERDATA) app.setPath('userData', process.env.MOODLE_DESKTOP_USERDATA);
// Frühere Namen („Moodle Desktop“ bis 1.2, „Campus Sync“ in 1.3): deren Profil (Anmeldung,
// Einstellungen, Cache) weiterverwenden – bevorzugt das, in dem wirklich Daten liegen
else {
  const appData = app.getPath('appData');
  const fresh = path.join(appData, app.getName());
  const hasData = (dir) => fs.existsSync(path.join(dir, 'settings.json')) || fs.existsSync(path.join(dir, 'secrets.json'));
  const old = ['Moodle Desktop', 'Campus Sync'].map((n) => path.join(appData, n));
  const legacy = old.find(hasData) || old.find((d) => fs.existsSync(d));
  if (app.getPath('userData') === fresh && legacy && !hasData(fresh)) {
    app.setPath('userData', legacy);
    // Electron legt den neuen Ordner schon beim Start leer an – nur dann entfernen, wenn er leer ist
    try {
      fs.rmdirSync(fresh);
    } catch {}
  }
}
const crypto = require('crypto');
const store = require('./store');
const { MoodleClient, getPublicConfig, loginWithPassword, loginWithBrowser, normalizeSite } = require('./moodle');
const { SyncEngine } = require('./sync');
const { ClaudeAssistant } = require('./claude');
const { ChatGPTAssistant } = require('./chatgpt');
const { ChatGPTAuth } = require('./chatgpt-auth');
const { DocIndex } = require('./docindex');
const { AiTools } = require('./ai-tools');
const { Updater } = require('./updater');
const { Timetables, RAPLA_TEMPLATE } = require('./timetable');
const { Mensa, DEFAULT_URL: MENSA_DEFAULT } = require('./mensa');

const ICON = path.join(__dirname, '..', '..', 'build', 'icon.png');
const APP_NAME = 'Chadoodle';
// Interne Kennung bleibt trotz Umbenennung gleich (Autostart-Eintrag, Taskleiste, Updates)
const LOGIN_ITEM = 'de.rbenz.moodledesktop';
// Versteckt starten: Autostart (--hidden) oder Neustart nach einem stillen Hintergrund-Update
const HIDDEN_FLAG = store.file('start-hidden');
let startHidden = process.argv.includes('--hidden');
if (fs.existsSync(HIDDEN_FLAG)) {
  startHidden = true;
  fs.rmSync(HIDDEN_FLAG, { force: true });
}

let win = null;
let tray = null;
let quitting = false;
const sync = new SyncEngine();
const docIndex = new DocIndex(sync);
const aiTools = new AiTools(sync, docIndex);
const timetables = new Timetables();
const mensa = new Mensa();
const claude = new ClaudeAssistant(aiTools);
const chatgptAuth = new ChatGPTAuth();
const chatgpt = new ChatGPTAssistant(aiTools, chatgptAuth);
const assistant = (provider) => (provider === 'chatgpt' ? chatgpt : claude);
const updater = new Updater({
  canRestartSilently: () => (!win || win.isDestroyed() || !win.isVisible()) && !sync.running && !claude.isBusy() && !chatgpt.isBusy() && !docIndex.busy,
  beforeInstall: ({ hidden }) => {
    if (hidden) fs.writeFileSync(HIDDEN_FLAG, '1');
    quitting = true;
    if (sync.cache) sync.save();
  },
});

protocol.registerSchemesAsPrivileged([
  { scheme: 'mfile', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (!argv.includes('--hidden')) showWindow();
  });
}

app.setAppUserModelId('de.rbenz.moodledesktop');

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: APP_NAME,
    icon: fs.existsSync(ICON) ? ICON : undefined,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#14161a' : '#f5f7fa',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (!startHidden) win.show();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      openExternal(url);
    }
  });
  win.on('close', (e) => {
    if (!quitting && store.getSettings().runInBackground && sync.client) {
      e.preventDefault();
      win.hide();
      if (!store.getSettings().trayHintShown && Notification.isSupported()) {
        new Notification({ title: `${APP_NAME} läuft weiter`, body: 'Die Synchronisation läuft im Hintergrund. Über das Tray-Symbol kannst du die App öffnen oder beenden.', icon: ICON }).show();
        store.setSettings({ trayHintShown: true });
      }
    }
  });
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  // Beim Öffnen nachsynchronisieren, falls der letzte Sync länger her ist
  const interval = Math.max(5, Number(store.getSettings().syncIntervalMin) || 30) * 60 * 1000;
  if (sync.client && sync.cache && Date.now() - sync.cache.lastSync > interval) sync.run();
}

function createTray() {
  const img = fs.existsSync(ICON) ? nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }) : nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setToolTip(`${APP_NAME} ${app.getVersion()}`);
  const menu = () =>
    Menu.buildFromTemplate([
      { label: `${APP_NAME} öffnen`, click: showWindow },
      { label: 'Jetzt synchronisieren', enabled: !!sync.client, click: () => sync.run() },
      { label: 'Download-Ordner öffnen', click: () => shell.openPath(store.getSettings().downloadDir) },
      { type: 'separator' },
      { label: 'Beenden', click: () => { quitting = true; app.quit(); } },
    ]);
  tray.setContextMenu(menu());
  tray.on('click', showWindow);
  sync.on('status', (s) => {
    tray.setToolTip(`${APP_NAME} ${app.getVersion()} – ${s.state === 'idle' ? 'synchronisiert' : s.message}`);
    tray.setContextMenu(menu());
  });
}

// Offizielle Bestellseite von my-mensa in einem eigenen Fenster. Eigenes, dauerhaftes Profil
// (Name/E-Mail merkt sich die Seite selbst), kein Zugriff auf die App; fremde Links → Browser.
let orderWin = null;
function openMensaOrder() {
  if (orderWin && !orderWin.isDestroyed()) {
    if (orderWin.isMinimized()) orderWin.restore();
    return orderWin.focus();
  }
  const url = mensa.url();
  const isMensa = (u) => {
    try {
      return /(^|\.)my-mensa\.de$/i.test(new URL(u).hostname);
    } catch {
      return false;
    }
  };
  orderWin = new BrowserWindow({
    width: 1120,
    height: 880,
    minWidth: 720,
    minHeight: 560,
    title: `Mensa bestellen – ${APP_NAME}`,
    icon: fs.existsSync(ICON) ? ICON : undefined,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: { partition: 'persist:mensa-order', contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  orderWin.removeMenu();
  orderWin.webContents.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:\/\//i.test(u)) shell.openExternal(u);
    return { action: 'deny' };
  });
  orderWin.webContents.on('will-navigate', (e, u) => {
    if (!isMensa(u)) {
      e.preventDefault();
      if (/^https?:\/\//i.test(u)) shell.openExternal(u);
    }
  });
  orderWin.on('page-title-updated', (e) => e.preventDefault());
  orderWin.on('closed', () => (orderWin = null));
  orderWin.loadURL(url);
}

async function openExternal(url) {
  if (!/^https?:\/\//i.test(url)) return;
  // Moodle-Seiten mit automatischer Anmeldung öffnen (wenn möglich)
  if (sync.client && sync.client.isSiteUrl(url)) url = await sync.client.autologinUrl(url);
  shell.openExternal(url);
}

function applyLoginItem() {
  if (!app.isPackaged) return;
  const s = store.getSettings();
  app.setLoginItemSettings({ openAtLogin: !!s.startWithWindows, name: LOGIN_ITEM, args: ['--hidden'], path: process.execPath });
}

function startSession() {
  const s = store.getSettings();
  const token = store.getSecret('moodleToken');
  if (!token || !s.siteUrl) return false;
  const client = new MoodleClient({ siteUrl: s.siteUrl, token, privateToken: store.getSecret('moodlePrivateToken') });
  sync.attach(client);
  sync.startTimer();
  setTimeout(() => sync.run(), 1500);
  return true;
}

// Bilder/Dateien aus HTML-Inhalten (pluginfile) mit Token laden und lokal cachen → offline verfügbar
function registerFileProtocol() {
  protocol.handle('mfile', async (req) => {
    const raw = decodeURIComponent(req.url.replace(/^mfile:\/\/file\/?/, ''));
    // Nur Dateien der eigenen Moodle-Seite laden: eine präparierte Adresse in Kursinhalten
    // würde sonst das Zugriffstoken an einen fremden Server schicken
    if (sync.client && !sync.client.isSiteUrl(raw)) return new Response('nicht erlaubt', { status: 403 });
    const dir = store.file(path.join('cache', 'media'));
    const key = path.join(dir, crypto.createHash('sha1').update(raw.split('?')[0]).digest('hex'));
    try {
      if (!sync.client) throw new Error('offline');
      const { buffer, type } = await sync.client.fetchBuffer(raw);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(key, buffer);
      fs.writeFileSync(key + '.type', type);
      return new Response(buffer, { headers: { 'content-type': type } });
    } catch {
      if (fs.existsSync(key)) {
        const type = fs.existsSync(key + '.type') ? fs.readFileSync(key + '.type', 'utf8') : 'application/octet-stream';
        return new Response(fs.readFileSync(key), { headers: { 'content-type': type } });
      }
      return new Response('nicht verfügbar', { status: 404 });
    }
  });
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

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('app:state', () => ({
    loggedIn: !!sync.client,
    settings: store.getSettings(),
    hasClaudeKey: !!store.getSecret('anthropicKey') || !!process.env.ANTHROPIC_API_KEY,
    version: app.getVersion(),
    update: updater.status,
    chatgpt: chatgptAuth.status(),
    index: sync.client ? docIndex.status() : null,
    status: sync.status,
  }));
  ipcMain.handle('data:get', () => sync.cache);

  ipcMain.handle('auth:check-site', async (_e, url) => {
    const cfg = await getPublicConfig(url);
    return {
      sitename: cfg.sitename,
      typeoflogin: cfg.typeoflogin, // 1 = App, 2 = Browser, 3 = eingebetteter Browser
      identityproviders: (cfg.identityproviders || []).map((p) => p.name),
      logourl: cfg.logourl || cfg.compactlogourl || null,
      url: normalizeSite(url),
    };
  });

  ipcMain.handle('auth:login', async (_e, { siteUrl, username, password, sso }) => {
    const site = normalizeSite(siteUrl);
    const result = sso ? await loginWithBrowser(site, win) : await loginWithPassword(site, username, password);
    store.setSettings({ siteUrl: site });
    store.setSecret('moodleToken', result.token);
    store.setSecret('moodlePrivateToken', result.privateToken);
    startSession();
    return true;
  });

  ipcMain.handle('auth:logout', async (_e, { deleteFiles }) => {
    // Nur die synchronisierten Dateien löschen, nie den ganzen Ordner: der Download-Ordner
    // kann frei gewählt sein (z. B. „Dokumente“) und andere Dateien enthalten.
    const files = deleteFiles && sync.cache ? Object.values(sync.cache.files).map((f) => f.localPath) : [];
    const courseDirs = deleteFiles && sync.cache ? sync.cache.courses.map((k) => sync.courseDir(k)) : [];
    sync.detach();
    store.setSecret('moodleToken', null);
    store.setSecret('moodlePrivateToken', null);
    for (const f of files) fs.rmSync(f, { force: true });
    for (const d of courseDirs) removeEmptyDirs(d);
    return true;
  });

  ipcMain.handle('sync:run', () => {
    sync.run();
    return true;
  });

  ipcMain.handle('settings:set', (_e, patch) => {
    const before = store.getSettings();
    const s = store.setSettings(patch);
    if (patch.syncIntervalMin && sync.client) sync.startTimer();
    if ('startWithWindows' in patch) applyLoginItem();
    if (patch.theme) nativeTheme.themeSource = patch.theme;
    if (patch.downloadDir && patch.downloadDir !== before.downloadDir && sync.cache) {
      // Neuer Ordner → Pfade neu berechnen und Dateien neu laden
      sync.cache.files = {};
      sync.save();
      sync.run();
    }
    return s;
  });

  ipcMain.handle('settings:set-claude-key', (_e, key) => {
    store.setSecret('anthropicKey', key || null);
    return true;
  });

  ipcMain.handle('settings:pick-folder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: store.getSettings().downloadDir });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('file:open', async (_e, id) => {
    const f = await sync.ensureFile(id);
    const err = await shell.openPath(f.localPath);
    if (err) throw new Error(err);
    return true;
  });
  ipcMain.handle('file:show', async (_e, id) => {
    const f = await sync.ensureFile(id);
    shell.showItemInFolder(f.localPath);
    return true;
  });
  ipcMain.handle('file:url', async (_e, id) => {
    const f = await sync.ensureFile(id);
    return require('url').pathToFileURL(f.localPath).href;
  });
  ipcMain.handle('folder:open', (_e, courseId) => {
    let dir = store.getSettings().downloadDir;
    if (courseId && sync.cache) {
      const k = sync.cache.courses.find((c) => c.id === courseId);
      if (k) dir = sync.courseDir(k);
    }
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
  });
  ipcMain.handle('open:external', (_e, url) => openExternal(url));
  ipcMain.handle('news:clear', () => {
    if (sync.cache) {
      sync.cache.newItems = [];
      sync.save();
    }
  });

  ipcMain.handle('ai:send', (e, payload) => {
    assistant(payload.provider).send(payload, (type, data) => {
      if (!e.sender.isDestroyed()) e.sender.send('ai:event', { conversationId: payload.conversationId, type, ...data });
    });
    return true;
  });
  ipcMain.handle('ai:stop', (_e, { provider, id }) => assistant(provider).stop(id));
  ipcMain.handle('update:status', () => updater.status);
  ipcMain.handle('update:check', () => updater.check());
  ipcMain.handle('update:install', () => updater.installNow());
  ipcMain.handle('ai:reset', (_e, { provider, id }) => assistant(provider).reset(id));

  // ChatGPT-Anmeldung (Plan-Nutzung)
  ipcMain.handle('chatgpt:status', () => chatgptAuth.status());
  ipcMain.handle('chatgpt:login', async (_e, opts) => {
    const st = await chatgptAuth.login(opts || {});
    chatgpt.modelCache = null;
    showWindow();
    return st;
  });
  ipcMain.handle('chatgpt:cancel', () => chatgptAuth.cancel());
  ipcMain.handle('chatgpt:logout', (_e, opts) => chatgptAuth.logout(opts || {}));
  ipcMain.handle('chatgpt:models', (_e, force) => chatgpt.models(!!force));
  ipcMain.handle('chatgpt:welcomed', () => chatgptAuth.markWelcomed());
  ipcMain.handle('chatgpt:open-log', () => {
    const f = require('./chatgpt-auth').LOG_FILE();
    if (fs.existsSync(f)) shell.openPath(f);
    else shell.openPath(path.dirname(path.dirname(f)));
  });

  // Stundenpläne
  ipcMain.handle('tt:list', () => ({ list: timetables.list(), active: store.getSettings().timetableActive, template: RAPLA_TEMPLATE }));
  ipcMain.handle('tt:events', (_e, id, from, to) => timetables.events(id, from, to));
  ipcMain.handle('tt:add', async (_e, t) => {
    const added = await timetables.add(t);
    store.setSettings({ timetableActive: added.id });
    return added;
  });
  ipcMain.handle('tt:remove', (_e, id) => timetables.remove(id));
  ipcMain.handle('tt:select', (_e, id) => store.setSettings({ timetableActive: id }));
  ipcMain.handle('tt:refresh', () => timetables.refreshAll());

  // Mensa-Speiseplan
  ipcMain.handle('mensa:get', (_e, force) => mensa.get(!!force));
  ipcMain.handle('mensa:set-url', (_e, url) => mensa.setUrl(url || MENSA_DEFAULT));
  ipcMain.handle('mensa:url', () => ({ url: mensa.url(), defaultUrl: MENSA_DEFAULT }));
  ipcMain.handle('mensa:order', () => openMensaOrder());

  // Dokumente: Volltextsuche, Seiten, Rohdaten für den PDF-Viewer
  ipcMain.handle('doc:search', (_e, q, opts) => docIndex.search(q, opts || {}));
  ipcMain.handle('doc:status', () => docIndex.status());
  ipcMain.handle('doc:pages', (_e, id, from, to) => docIndex.getPages(id, from, to));
  ipcMain.handle('file:data', async (_e, id) => {
    const f = await sync.ensureFile(id);
    return new Uint8Array(fs.readFileSync(f.localPath));
  });
}

app.whenReady().then(() => {
  nativeTheme.themeSource = store.getSettings().theme || 'system';
  registerFileProtocol();
  registerIpc();
  createWindow();
  createTray();
  applyLoginItem();

  sync.on('status', (s) => send('sync:status', s));
  sync.on('updated', () => send('data:updated'));
  sync.on('files', () => {
    send('data:files');
    docIndex.indexPending();
  });
  docIndex.on('progress', (st) => send('index:status', st));
  sync.on('invalidtoken', () => send('auth:expired'));
  sync.on('notify', (n) => {
    if (!Notification.isSupported()) return;
    const note = new Notification({ title: n.title, body: n.body, icon: ICON });
    note.on('click', showWindow);
    note.show();
  });

  timetables.on('changed', () => send('tt:changed'));
  timetables.start();
  mensa.on('changed', () => send('mensa:changed'));
  mensa.start();

  updater.on('status', (st) => send('update:status', st));
  updater.start();

  // Nach Standby/Ruhezustand sofort synchronisieren und nach Updates schauen
  powerMonitor.on('resume', () => setTimeout(() => {
    sync.run();
    updater.check();
    chatgptAuth.keepAlive();
  }, 15000));

  // ChatGPT-Anmeldung regelmäßig erneuern, damit man sich nicht neu anmelden muss
  setTimeout(() => chatgptAuth.keepAlive(), 60 * 1000);
  setInterval(() => chatgptAuth.keepAlive(), 6 * 60 * 60 * 1000);

  const loggedIn = startSession();
  if (loggedIn) setTimeout(() => docIndex.indexPending(), 8000);
  // Autostart ohne Anmeldung ergibt keinen Sinn – dann gar nicht erst im Hintergrund bleiben
  if (startHidden && !loggedIn) app.quit();
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('window-all-closed', () => {
  if (!store.getSettings().runInBackground || !sync.client) app.quit();
});
