// Web-Version von Chadoodle: übernimmt die Rolle von src/main/main.js (Hauptprozess) und
// src/preload.js (window.api) direkt im Browser. Die Module aus src/main laufen unverändert;
// Dateien liegen in IndexedDB (siehe shims/fs.js), Moodle-Medien liefert der Service Worker.
const vfs = require('./shims/fs');
const { vfsUrl } = require('./shims/url');
const store = require('../src/main/store');
const { MoodleClient, MoodleError, getPublicConfig, loginWithPassword, prepareBrowserLogin, parseLaunchToken, normalizeSite } = require('../src/main/moodle');
const { SyncEngine, media } = require('../src/main/sync');
const { ClaudeAssistant } = require('../src/main/claude');
const { DocIndex } = require('../src/main/docindex');
const { AiTools } = require('../src/main/ai-tools');
const { Timetables, RAPLA_TEMPLATE } = require('../src/main/timetable');
const { Mensa, DEFAULT_URL: MENSA_DEFAULT } = require('../src/main/mensa');
const { Account } = require('../src/main/account');
const { Anthropic } = require('@anthropic-ai/sdk');

const VERSION = globalThis.CHADOODLE_VERSION;
const ICON = '/icon.png';
document.documentElement.classList.add('web');

// ---------- Netzwerk ----------
// Moodle, my-mensa (Speiseplan) und Anthropic erlauben Browser-Zugriffe (CORS). Rapla und die
// Bestell-API von my-mensa nicht – die gehen über die eigene Pages Function (/api/proxy).
const nativeFetch = globalThis.fetch.bind(globalThis);
const PROXY_HOSTS = [/^rapla\.dhbw\.de$/i, /^togo\.my-mensa\.de$/i];
const viaProxy = (u, init) => nativeFetch('/api/proxy?url=' + encodeURIComponent(u.href), { method: init.method || 'GET', headers: init.headers, body: init.body, signal: init.signal });
globalThis.fetch = async (input, init = {}) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  let u;
  try {
    u = new URL(raw, location.href);
  } catch {
    return nativeFetch(input, init);
  }
  if (u.origin === location.origin || u.protocol !== 'https:') return nativeFetch(input, init);
  try {
    if (PROXY_HOSTS.some((r) => r.test(u.hostname))) return await viaProxy(u, init);
    return await nativeFetch(input, init);
  } catch (e) {
    if (e.name === 'AbortError' || e.name === 'TimeoutError') throw e;
    const method = String(init.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
    // Lesende Abrufe fremder Seiten ohne CORS (z. B. iCal-Links) über den Proxy wiederholen –
    // nie Moodle (Token) und nie die KI-Anbieter
    const own = /(^|\.)(anthropic\.com|supabase\.co)$/i.test(u.hostname) || (sync.client && sync.client.isSiteUrl(u.href));
    if (method === 'GET' && navigator.onLine && !own && !PROXY_HOSTS.some((r) => r.test(u.hostname))) {
      try {
        return await viaProxy(u, init);
      } catch {}
    }
    // Wie Node („fetch failed“), damit die Module Offline-Fehler erkennen
    throw Object.assign(new TypeError('fetch failed'), { cause: e });
  }
};

// Downloads landen in IndexedDB statt im Dateisystem
MoodleClient.prototype.download = async function (url, dest) {
  const res = await fetch(this.fileUrl(url));
  if (!res.ok) throw new MoodleError(`Download fehlgeschlagen (HTTP ${res.status})`, 'http');
  const type = res.headers.get('content-type') || '';
  if (type.includes('application/json')) {
    const data = await res.json().catch(() => ({}));
    throw new MoodleError(data.error || data.message || 'Download verweigert', data.errorcode);
  }
  await vfs.writeBlob(dest, new Uint8Array(await res.arrayBuffer()));
};

// Im Browser braucht die Anthropic-SDK die ausdrückliche Freigabe (der Key gehört dem Nutzer selbst)
ClaudeAssistant.prototype.client = function () {
  const key = store.getSecret('anthropicKey');
  if (!key) throw new Error('Bitte zuerst einen Anthropic-API-Key hinterlegen.');
  return new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
};

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
aiTools.timetables = timetables;
aiTools.mensa = mensa;
aiTools.onPrepareCart = (cart) => send('mensa:prepare', cart);
aiTools.onOrdered = (entry) => send('mensa:ordered', entry);
const orderConfirms = new Map();
aiTools.confirmOrder = (summary) =>
  new Promise((resolve) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => orderConfirms.delete(id) && resolve(false), 10 * 60 * 1000);
    orderConfirms.set(id, (ok) => {
      clearTimeout(timer);
      resolve(ok);
    });
    window.focus();
    send('mensa:confirm', { id, ...summary });
  });
const claude = new ClaudeAssistant(aiTools);

// Synchrones Lesen (KI-Anhänge, read_file) klappt nur für Dateien im Zwischenspeicher
const ensureFile = sync.ensureFile.bind(sync);
sync.ensureFile = async (id) => {
  const f = await ensureFile(id);
  await vfs.preload(f.localPath);
  return f;
};

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

// Fenster/Tab synchron öffnen (sonst blockt der Popup-Blocker nach einem await), Ziel später setzen
function openTab() {
  const w = window.open('', '_blank');
  if (w) w.opener = null;
  return {
    go(url) {
      if (w && !w.closed) w.location.href = url;
      else window.open(url, '_blank', 'noopener');
    },
    close() {
      if (w && !w.closed) w.close();
    },
  };
}

async function openExternal(url, tab) {
  if (!/^https?:\/\//i.test(url)) return tab && tab.close();
  tab = tab || openTab();
  if (sync.client && sync.client.isSiteUrl(url)) url = await sync.client.autologinUrl(url);
  tab.go(url);
}

function saveAs(name, bytes, type = 'application/octet-stream') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60 * 1000);
}

// ---------- SSO im Browser ----------
// Moodle leitet nach der Anmeldung auf moodlemobile://token=… um – das kann eine Webseite nicht
// abfangen. Mit „confirmed=1“ zeigt Moodle stattdessen einen Link „App starten“, dessen Adresse
// man kopiert und hier einfügt. Die Signatur (passport) wird wie in der Desktop-App geprüft.
function ssoDialog(siteUrl) {
  const tab = openTab();
  return new Promise((resolve, reject) => {
    let login = null;
    prepareBrowserLogin(siteUrl, '&confirmed=1')
      .then((l) => {
        login = l;
        tab.go(l.launch);
      })
      .catch((e) => {
        tab.close();
        finish(e);
      });
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.id = 'web-sso';
    bg.innerHTML = `<div class="modal" style="width:min(540px,calc(100vw - 32px))">
      <h3>Über den Browser anmelden</h3>
      <p>Im neuen Tab meldest du dich wie gewohnt bei Moodle an. Danach erscheint dort ein Link <b>„App starten“</b> (bzw. „Click here to launch the app“).</p>
      <ol class="small" style="margin:0 0 14px;padding-left:20px;color:var(--text-2)">
        <li>Rechtsklick auf den Link → <b>Link-Adresse kopieren</b></li>
        <li>Die Adresse (beginnt mit <code>moodlemobile://token=</code>) hier einfügen:</li>
      </ol>
      <form><input class="input" name="link" placeholder="moodlemobile://token=…" autocomplete="off" spellcheck="false" />
        <p class="err small" style="margin:8px 0 0" hidden></p>
        <div class="row"><button type="button" class="btn" data-x="cancel">Abbrechen</button><button type="button" class="btn ghost" data-x="reopen">Tab erneut öffnen</button><button class="btn primary">Anmelden</button></div>
      </form></div>`;
    document.body.appendChild(bg);
    const input = bg.querySelector('input');
    const err = bg.querySelector(".err");
    setTimeout(() => input.focus(), 50);
    let closed = false;
    function finish(e, val) {
      if (closed) return;
      closed = true;
      bg.remove();
      e ? reject(e) : resolve(val);
    }
    bg.querySelector('[data-x="cancel"]').onclick = () => finish(new MoodleError('Anmeldung abgebrochen', 'cancelled'));
    bg.querySelector('[data-x="reopen"]').onclick = () => login && openTab().go(login.launch);
    bg.querySelector('form').onsubmit = (e) => {
      e.preventDefault();
      err.hidden = true;
      try {
        if (!login) throw new Error('Moment – die Anmeldung wird noch vorbereitet.');
        const r = parseLaunchToken(input.value, login.valid);
        if (!r) throw new Error('Das ist nicht die Adresse des „App starten“-Links (sie beginnt mit moodlemobile://token=).');
        finish(null, r);
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
      }
    };
  });
}

// ---------- Handler (gleiche Namen/Verhalten wie die IPC-Kanäle in main.js) ----------
const unsupported = (what) => () => Promise.reject(new Error(`${what} gibt es nur in der Desktop-App.`));
const CHATGPT_OFF = { signedIn: false, planUsage: false, unavailable: true };

const handlers = {
  state: () => ({
    loggedIn: !!sync.client,
    settings: { ...store.getSettings(), aiProvider: 'claude' },
    hasClaudeKey: !!store.getSecret('anthropicKey'),
    account: account.status,
    version: VERSION,
    update: { state: 'web' },
    chatgpt: CHATGPT_OFF,
    index: sync.client ? docIndex.status() : null,
    status: sync.status,
  }),
  data: () => sync.cache,

  async checkSite(url) {
    const cfg = await getPublicConfig(url);
    return {
      sitename: cfg.sitename,
      typeoflogin: cfg.typeoflogin,
      identityproviders: (cfg.identityproviders || []).map((p) => p.name),
      logourl: cfg.logourl || cfg.compactlogourl || null,
      url: normalizeSite(url),
    };
  },
  async login({ siteUrl, username, password, sso }) {
    const site = normalizeSite(siteUrl);
    const result = sso ? await ssoDialog(site) : await loginWithPassword(site, username, password);
    store.setSettings({ siteUrl: site });
    store.setSecret('moodleToken', result.token);
    store.setSecret('moodlePrivateToken', result.privateToken);
    startSession();
    account.login(site, result.token).catch((e) => account.setStatus('error', e.message));
    return true;
  },
  async logout({ deleteFiles }) {
    const files = deleteFiles && sync.cache ? Object.values(sync.cache.files).map((f) => f.localPath) : [];
    sync.detach();
    await account.logout();
    store.setSecret('moodleToken', null);
    store.setSecret('moodlePrivateToken', null);
    for (const f of files) vfs.rmSync(f, { force: true });
    return true;
  },
  sync: () => {
    sync.run();
    return true;
  },
  setSettings(patch) {
    const s = store.setSettings(patch);
    if (patch.syncIntervalMin && sync.client) sync.startTimer();
    if (patch.notifications && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    return { ...s, aiProvider: 'claude' };
  },
  setClaudeKey(key) {
    store.setSecret('anthropicKey', key || null);
    account.keyChanged(key || null);
    return true;
  },
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
  pickFolder: () => null,
  async openFile(id, tab) {
    try {
      const f = await sync.ensureFile(id);
      tab.go(vfsUrl(f.localPath));
    } catch (e) {
      tab.close();
      throw e;
    }
    return true;
  },
  async showFile(id) {
    const f = await sync.ensureFile(id);
    saveAs(f.filename, await vfs.readFileAsync(f.localPath), f.mimetype || undefined);
    return true;
  },
  async fileUrl(id) {
    const f = await sync.ensureFile(id);
    return vfsUrl(f.localPath);
  },
  openFolder: () => {},
  openExternal: (url, tab) => openExternal(url, tab),
  clearNews() {
    if (sync.cache) {
      sync.cache.newItems = [];
      sync.save();
    }
  },

  aiSend(payload) {
    claude.send(payload, (type, data) => send('ai:event', { conversationId: payload.conversationId, type, ...data }));
    return true;
  },
  aiStop: (_provider, id) => claude.stop(id),
  aiReset: (_provider, id) => claude.reset(id),

  chatgptStatus: () => CHATGPT_OFF,
  chatgptLogin: unsupported('Die ChatGPT-Anmeldung'),
  chatgptCancel: () => {},
  chatgptLogout: () => CHATGPT_OFF,
  chatgptModels: () => [],
  chatgptWelcomed: () => {},
  chatgptOpenLog: () => {},

  docSearch: (q, opts) => docIndex.search(q, opts || {}),
  docStatus: () => docIndex.status(),
  docPages: (id, from, to) => docIndex.getPages(id, from, to),
  async fileData(id) {
    const f = await sync.ensureFile(id);
    return (await vfs.readFileAsync(f.localPath)).slice();
  },

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

  mensaGet: (force) => mensa.get(!!force),
  mensaSetUrl: (url) => mensa.setUrl(url || MENSA_DEFAULT),
  mensaUrl: () => ({ url: mensa.url(), defaultUrl: MENSA_DEFAULT }),
  mensaOrder: (tab) => tab.go(mensa.url()),
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

  // Zugangs-Cookie der Website löschen (functions/api/gate.js) → Login-Seite
  async gateLogout() {
    await vfs.flush();
    await nativeFetch('/api/gate', { method: 'DELETE' }).catch(() => {});
    location.reload();
  },
  updateStatus: () => ({ state: 'web' }),
  updateCheck: () => {},
  updateInstall: () => location.reload(),
};

// ---------- Start ----------
// Nur ein Tab synchronisiert: zwei Sync-Dienste würden sich gegenseitig den Speicher überschreiben
function blocked() {
  return new Promise(() => {
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal"><h3>Chadoodle ist schon geöffnet</h3>
      <p>Chadoodle läuft bereits in einem anderen Tab oder Fenster. Es kann immer nur eines aktiv sein.</p>
      <div class="row"><button class="btn primary">Hier verwenden</button></div></div>`;
    bg.querySelector('button').onclick = () => {
      sessionStorage.setItem('chadoodle-steal', '1');
      location.reload();
    };
    document.body.appendChild(bg);
  });
}

function acquireLock() {
  if (!navigator.locks) return Promise.resolve();
  const steal = sessionStorage.getItem('chadoodle-steal') === '1';
  sessionStorage.removeItem('chadoodle-steal');
  return new Promise((resolve) => {
    navigator.locks
      .request('chadoodle-main', steal ? { steal: true } : { ifAvailable: true }, (lock) => {
        if (!lock) return resolve(blocked());
        resolve();
        return new Promise(() => {}); // Sperre halten, solange der Tab offen ist
      })
      // Ein anderer Tab hat übernommen: hier anhalten
      .catch(() => {
        vfs.flush();
        location.reload();
      });
  });
}

const ready = (async () => {
  await acquireLock();
  await vfs.init();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('Service Worker', e));

  sync.on('status', (s) => send('sync:status', s));
  sync.on('updated', () => send('data:updated'));
  sync.on('files', () => {
    send('data:files');
    docIndex.indexPending();
  });
  docIndex.on('progress', (st) => send('index:status', st));
  sync.on('invalidtoken', () => send('auth:expired'));
  sync.on('notify', (n) => {
    if (!('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
    const note = new Notification(n.title, { body: n.body, icon: ICON });
    note.onclick = () => window.focus();
  });
  timetables.on('changed', () => send('tt:changed'));
  timetables.start();
  mensa.on('changed', () => send('mensa:changed'));
  mensa.start();

  account.on('status', (st) => send('account:status', st));
  account.on('changed', (c) => {
    const s = c.settings || {};
    if ('timetables' in s) timetables.refreshAll();
    else if ('timetableActive' in s) send('tt:changed');
    if ('mensaUrl' in s) mensa.fetch().catch(() => {});
    send('account:changed', { settings: Object.keys(s), key: !!c.key, orders: !!c.orders });
  });
  account.start();

  // Zurück im Tab oder wieder online: nachsynchronisieren, falls der letzte Sync länger her ist
  const catchUp = () => {
    const interval = Math.max(5, Number(store.getSettings().syncIntervalMin) || 30) * 60 * 1000;
    if (sync.client && sync.cache && Date.now() - sync.cache.lastSync > interval) sync.run();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    catchUp();
    account.pull();
  });
  window.addEventListener('online', () => sync.run());
  window.addEventListener('pagehide', () => vfs.flush());

  if (startSession()) setTimeout(() => docIndex.indexPending(), 8000);
})();

// Aufrufe, die ein Fenster öffnen, bekommen es synchron (Popup-Blocker)
const TAB_CALLS = new Set(['openFile', 'openExternal', 'mensaOrder']);
const api = { platform: 'web' };
for (const [name, fn] of Object.entries(handlers)) {
  api[name] = (...args) => {
    if (TAB_CALLS.has(name)) args.push(openTab());
    return ready.then(() => fn(...args)).then((r) => (name === 'fileData' ? r : clone(r)));
  };
}
Object.assign(api, {
  onTimetables: on('tt:changed'),
  onMensa: on('mensa:changed'),
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
// Gleiche Aufrufform wie preload.js
api.aiStop = (provider, id) => ready.then(() => handlers.aiStop(provider, id));
api.aiReset = (provider, id) => ready.then(() => handlers.aiReset(provider, id));
window.api = api;
