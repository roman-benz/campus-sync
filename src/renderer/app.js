/* Chadoodle – Oberfläche. Liest ausschließlich den lokalen Cache aus dem Hauptprozess. */
// `api` ist das globale Objekt aus preload.js (contextBridge)
const $ = (sel, root = document) => root.querySelector(sel);

const S = {
  state: null,
  data: null,
  status: { state: 'idle', message: '' },
  update: { state: 'idle' },
  updateDismissed: null,
  route: { name: 'dashboard', params: {} },
  history: [],
  ui: {
    leftOpen: true,
    claudeOpen: false,
    dropdown: null,
    collapsed: {},
    openFolders: {},
    courseFilter: 'inprogress',
    courseSort: 'access',
    courseView: 'cards',
    courseSearch: '',
    tlRange: '30',
    fileSearch: '',
    settingsTab: 'sync',
  },
  login: { step: 'site', site: null, error: '', busy: false },
  chats: { claude: newChat(), chatgpt: newChat() },
  chatgpt: null,
  gptModels: null,
  gptLogin: false,
  index: null,
  search: null,
  // Stundenplan: Liste der Pläne, angezeigte Woche (Montag 0 Uhr) und deren Termine
  mensa: { data: null, day: null, busy: false, error: '', url: null, defaultUrl: null, form: '', tt: null },
  tt: { list: null, active: null, template: null, week: ttMonday(new Date()), events: [], loadedKey: null, busy: false, form: { name: '', url: '' } },
};
// Aktiver Chat = Chat des gewählten KI-Anbieters
Object.defineProperty(S, 'chat', { get: () => S.chats[prov()] });

function newChat() {
  return { id: 'c' + Math.random().toString(36).slice(2), messages: [], busy: false, attachments: [], ctxOn: true };
}

// ---------- Hilfsfunktionen ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const strip = (h) => { const d = document.createElement('div'); d.innerHTML = DOMPurify.sanitize(h || ''); return d.textContent.trim(); };
const clean = (h) => DOMPurify.sanitize(h || '', { ADD_ATTR: ['target'], FORBID_TAGS: ['style', 'form', 'input', 'button'] });
const fmtSize = (b) => (!b ? '' : b >= 1048576 ? (b / 1048576).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
const fmtDate = (ts, opts = { day: '2-digit', month: '2-digit', year: 'numeric' }) => (ts ? new Date(ts * 1000).toLocaleDateString('de-DE', opts) : '–');
const fmtDateTime = (ts) => (ts ? new Date(ts * 1000).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–');
const fmtTime = (ts) => new Date(ts * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const initials = (n) => String(n || '?').split(/\s+/).map((x) => x[0]).slice(0, 2).join('').toUpperCase();

function relTime(ms) {
  if (!ms) return 'noch nie';
  const d = (Date.now() - ms) / 1000;
  if (d < 60) return 'gerade eben';
  if (d < 3600) return `vor ${Math.floor(d / 60)} Min.`;
  if (d < 86400) return `vor ${Math.floor(d / 3600)} Std.`;
  return `vor ${Math.floor(d / 86400)} Tag${d >= 172800 ? 'en' : ''}`;
}

function dueIn(ts) {
  const d = ts - Date.now() / 1000;
  if (d < 0) return { text: 'Überfällig', cls: 'danger' };
  if (d < 12 * 3600) return { text: `in ${Math.max(1, Math.round(d / 3600))} Std.`, cls: 'danger' };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(ts * 1000); day.setHours(0, 0, 0, 0);
  const days = Math.round((day - today) / 86400000);
  if (days === 0) return { text: `heute, ${fmtTime(ts)}`, cls: 'danger' };
  if (days === 1) return { text: 'morgen', cls: 'warn' };
  return { text: `in ${days} Tagen`, cls: days <= 3 ? 'warn' : 'info' };
}

function dayLabel(ts) {
  const d = new Date(ts * 1000);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const diff = Math.round((day - today) / 86400000);
  if (diff === 0) return 'Heute';
  if (diff === 1) return 'Morgen';
  if (diff === -1) return 'Gestern';
  return d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
}

const MOD = {
  resource: ['Datei', 'filetext', 'content'], folder: ['Verzeichnis', 'folder', 'content'], page: ['Textseite', 'file', 'content'],
  url: ['Link', 'link', 'content'], book: ['Buch', 'book', 'content'], label: ['Textfeld', 'label', 'content'],
  assign: ['Aufgabe', 'clipboard', 'assessment'], quiz: ['Test', 'quiz', 'assessment'], workshop: ['Gegenseitige Beurteilung', 'users', 'assessment'],
  forum: ['Forum', 'message', 'communication'], chat: ['Chat', 'message', 'communication'], choice: ['Abstimmung', 'checkcircle', 'communication'],
  feedback: ['Feedback', 'checkcircle', 'communication'], survey: ['Umfrage', 'checkcircle', 'communication'], bigbluebuttonbn: ['BigBlueButton', 'video', 'communication'],
  glossary: ['Glossar', 'book', 'collaboration'], wiki: ['Wiki', 'layers', 'collaboration'], data: ['Datenbank', 'grid', 'collaboration'],
  h5pactivity: ['H5P', 'puzzle', 'interactivecontent'], scorm: ['SCORM-Paket', 'layers', 'interactivecontent'], lesson: ['Lektion', 'layers', 'interactivecontent'],
  lti: ['Externes Tool', 'puzzle', 'interactivecontent'], attendance: ['Anwesenheit', 'users', 'administration'],
};
const modInfo = (m) => {
  const def = MOD[m.modname] || [m.modname, 'puzzle', 'other'];
  return { label: def[0], icon: def[1], purpose: m.purpose || def[2] };
};
const actIcon = (m, size = '') => { const i = modInfo(m); return `<div class="act-icon ${size} p-${i.purpose}">${icon(i.icon)}</div>`; };

function courseBg(k) {
  if (k && k.image) return `background-image:url("${k.image.replace(/"/g, '%22')}")`;
  // Platzhalter ohne Kursbild: nur warme und grüne Farbtöne, keine Blautöne
  const HUES = [14, 28, 40, 352, 330, 150, 168, 85];
  const h = HUES[(k ? k.id : 1) % HUES.length];
  return `background-image:linear-gradient(135deg, hsl(${h} 62% 50%), hsl(${(h + 18) % 360} 58% 38%))`;
}

const courses = () => (S.data ? S.data.courses : []);
const courseById = (id) => courses().find((k) => k.id === Number(id));
function findModule(cmid) {
  if (!S.data) return null;
  for (const [cid, sections] of Object.entries(S.data.contents)) {
    for (const s of sections) for (const m of s.modules) if (m.id === Number(cmid)) return { courseId: Number(cid), section: s, mod: m };
  }
  return null;
}
const filesOfModule = (m) => {
  const list = (m.contents || []).filter((f) => f.id && f.type === 'file');
  const a = S.data.assignments[m.id];
  if (a) list.push(...a.attachments.filter((f) => f.id));
  return list.map((f) => S.data.files[f.id]).filter(Boolean);
};

function toast(msg, err = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.innerHTML = (err ? icon('alert', 'sm') : icon('check', 'sm')) + `<span>${esc(msg)}</span>`;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 3800);
}

function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

// ---------- Markdown + Formeln ----------
marked.use({ gfm: true, breaks: false });
function renderMd(src) {
  const math = [];
  const parts = String(src || '').split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g);
  const withMath = parts
    .map((p, i) => (i % 2 ? p : p.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<![\\$\w])\$(?![\s$])([^\n$]+?)(?<!\s)\$(?![\w$])/g, (_m, a, b, c, d) => {
      math.push({ tex: a ?? b ?? c ?? d, display: a != null || b != null });
      return `${math.length - 1}`;
    })))
    .join('');
  let html = DOMPurify.sanitize(marked.parse(withMath), { ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|doc):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i });
  html = html.replace(/(\d+)/g, (_m, i) => {
    try {
      return katex.renderToString(math[i].tex, { displayMode: math[i].display, throwOnError: false });
    } catch {
      return esc(math[i].tex);
    }
  });
  return html;
}

// ---------- Start ----------
async function boot() {
  S.state = await api.state();
  applyTheme(S.state.settings.theme);
  S.status = S.state.status || S.status;
  S.update = S.state.update || S.update;
  S.chatgpt = S.state.chatgpt;
  S.index = S.state.index;
  if (S.state.loggedIn) S.data = await api.data();
  render();

  api.onSyncStatus((st) => { S.status = st; renderSyncPill(); });
  api.onDataUpdated(async () => { S.data = await api.data(); renderNav(); renderLeft(); renderMain(); });
  api.onFilesUpdated(async () => { S.data = await api.data(); if (['course', 'module', 'dashboard'].includes(S.route.name)) renderMain(); });
  api.onMensa(() => { if (S.route.name === 'mensa') loadMensa(); });
  api.onTimetables(() => { if (S.route.name === 'timetable') loadTimetable(true); });
  setInterval(() => {
    placeNowLine();
    // Neue Woche angebrochen: Termine der aktuellen Woche neu laden, sonst nur die Anzeige auffrischen
    if (S.route.name === 'timetable' && S.tt.nowKey && S.tt.nowKey !== `${S.tt.active}|${ttMonday(new Date())}`) loadTimetable();
    else updateTtProgress();
  }, 30 * 1000);
  api.onAuthExpired(() => toast('Moodle-Sitzung abgelaufen – bitte neu anmelden.', true));
  api.onAi(onAiEvent);
  api.onIndexStatus((st) => {
    S.index = st;
    const el = document.getElementById('index-status');
    if (el) el.textContent = indexText();
  });
  if (S.chatgpt && S.chatgpt.signedIn) api.chatgptModels().then((m) => { S.gptModels = m; renderClaude(); }).catch(() => {});
  api.onUpdateStatus((st) => {
    S.update = st;
    renderUpdateBanner();
    if (S.route.name === 'settings' && S.ui.settingsTab === 'update') renderMain();
  });
}

function render() {
  const app = $('#app');
  if (!S.state.loggedIn) {
    app.innerHTML = renderLogin();
    return;
  }
  app.innerHTML = `
    <header class="navbar" id="nav"></header>
    <div class="shell">
      <aside class="drawer-left" id="left"></aside>
      <main class="main" id="main"></main>
      <aside class="claude-panel closed" id="claude"></aside>
    </div>
    <div id="update-banner"></div>`;
  renderNav();
  renderLeft();
  renderMain();
  renderClaude();
  renderUpdateBanner();
}

function updateText(u) {
  switch (u.state) {
    case 'dev': return 'Entwicklungsversion – automatische Updates sind deaktiviert.';
    case 'checking': return 'Suche nach Updates…';
    case 'uptodate': return `Du hast die neueste Version${u.lastCheck ? ' · geprüft ' + relTime(u.lastCheck) : ''}.`;
    case 'downloading': return `Lade Version ${u.version || ''} herunter… ${u.progress || 0} %`;
    case 'ready': return `Version ${u.version} ist heruntergeladen und wird beim nächsten Neustart installiert.`;
    case 'error': return 'Update-Server gerade nicht erreichbar – neuer Versuch später.';
    default: return 'Updates werden automatisch geprüft.';
  }
}

function renderUpdateBanner() {
  const el = $('#update-banner');
  if (!el) return;
  const u = S.update || {};
  if (u.state !== 'ready' || S.updateDismissed === u.version) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="update-banner">
    <div class="cp-logo" style="background:var(--primary-soft);color:var(--primary-text)">${icon('download')}</div>
    <div class="grow"><b>Update ${esc(u.version)} ist bereit</b><small>Neu starten, um es jetzt zu installieren – sonst automatisch später.</small></div>
    <button class="btn sm ghost" data-action="update-later">Später</button>
    <button class="btn sm primary" data-action="update-install">Neu starten</button>
  </div>`;
}

// ---------- Login ----------
function renderLogin() {
  const L = S.login;
  const s = L.site;
  let body;
  if (L.step === 'site') {
    body = `
      <form data-submit="check-site">
        <div class="field">
          <label for="site">Moodle-Adresse deiner Hochschule</label>
          <div class="input-icon">${icon('link')}<input id="site" class="input" value="${esc(S.state.settings.siteUrl)}" placeholder="https://moodle.beispiel.de" autofocus /></div>
        </div>
        <button class="btn primary block" ${L.busy ? 'disabled' : ''}>${L.busy ? icon('refresh', 'spin') : ''} Weiter</button>
      </form>`;
  } else {
    const ssoOnly = s.typeoflogin === 2 || s.typeoflogin === 3;
    const sso = `<button class="btn ${ssoOnly ? 'primary' : ''} block" data-action="login-sso" ${L.busy ? 'disabled' : ''}>${icon('external')} Über Browser anmelden${s.identityproviders.length ? ' (' + esc(s.identityproviders.join(', ')) + ')' : ' (SSO)'}</button>`;
    body = `
      <div class="site-chip">
        ${s.logourl ? `<img src="${esc(s.logourl)}" alt="" />` : `<div class="act-icon sm p-content">${icon('graduation')}</div>`}
        <div class="grow"><b>${esc(s.sitename)}</b><small>${esc(s.url)}</small></div>
        <button class="btn ghost sm" data-action="login-back">Ändern</button>
      </div>
      ${ssoOnly ? sso + '<div class="divider">oder mit Moodle-Konto</div>' : ''}
      <form data-submit="login-pw">
        <div class="field"><label for="user">Anmeldename</label><input id="user" class="input" autocomplete="username" ${ssoOnly ? '' : 'autofocus'} /></div>
        <div class="field"><label for="pw">Kennwort</label><input id="pw" type="password" class="input" autocomplete="current-password" /></div>
        <button class="btn ${ssoOnly ? '' : 'primary'} block" ${L.busy ? 'disabled' : ''}>${L.busy ? icon('refresh', 'spin') : ''} Anmelden</button>
      </form>
      ${ssoOnly ? '' : '<div class="divider">oder</div>' + sso}`;
  }
  return `
    <div class="login">
      <div class="login-card">
        <div class="login-brand">
          <div class="brand-mark">${icon('graduation')}</div>
          <div><h1>Chadoodle</h1><div class="sub">Deine Moodle-Kurse lokal – mit KI-Lernassistent</div></div>
        </div>
        ${L.error ? `<div class="error">${esc(L.error)}</div>` : ''}
        ${body}
        <div class="login-foot">Die App lädt deine Kursinhalte im Hintergrund herunter. Dein Kennwort wird nicht gespeichert, nur ein verschlüsseltes Zugriffstoken.</div>
      </div>
    </div>`;
}

async function loginDone() {
  S.state = await api.state();
  S.data = await api.data();
  S.login = { step: 'site', site: null, error: '', busy: false };
  render();
  toast('Angemeldet – erste Synchronisation läuft…');
}

const submits = {
  async 'mensa-url'() {
    const m = S.mensa;
    const url = (m.form || '').trim();
    if (!url || url === m.url) return;
    m.busy = true;
    renderMain();
    try {
      m.data = await api.mensaSetUrl(url);
      m.url = url;
      m.form = '';
      m.error = '';
      m.day = null;
      toast('Mensa übernommen');
    } catch (e) {
      toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true);
    } finally {
      m.busy = false;
      loadMensa();
    }
  },
  async 'tt-add'() {
    const f = S.tt.form;
    if (!f.url.trim()) return toast('Bitte einen Link eingeben.', true);
    S.tt.busy = true;
    renderMain();
    try {
      await api.ttAdd({ name: f.name, url: f.url });
      S.tt.form = { name: '', url: '' };
      S.tt.week = ttMonday(new Date());
      toast('Stundenplan hinzugefügt');
    } catch (e) {
      toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true);
    } finally {
      S.tt.busy = false;
      await loadTimetable(true);
    }
  },
  async 'check-site'() {
    const url = $('#site').value.trim();
    if (!url) return;
    S.login.busy = true; S.login.error = ''; render();
    try {
      S.login.site = await api.checkSite(url);
      S.login.step = 'login';
    } catch (e) {
      S.login.error = 'Diese Adresse ist keine erreichbare Moodle-Seite (oder die Moodle-App-Schnittstelle ist deaktiviert).';
    }
    S.login.busy = false; render();
  },
  async 'login-pw'() {
    const username = $('#user').value.trim();
    const password = $('#pw').value;
    if (!username || !password) return;
    S.login.busy = true; S.login.error = ''; render();
    try {
      await api.login({ siteUrl: S.login.site.url, username, password });
      await loginDone();
    } catch (e) {
      S.login.busy = false;
      S.login.error = cleanErr(e) || 'Anmeldung fehlgeschlagen.';
      render();
    }
  },
  async 'claude-key'() {
    const key = $('#claude-key-input').value.trim();
    if (!key) return;
    await api.setClaudeKey(key);
    S.state = await api.state();
    renderClaude();
    if (S.route.name === 'settings') renderMain();
    toast('API-Key gespeichert');
  },
  'claude-send'() { sendWithSelection(); },
  'nav-search'() { const q = $('#nav-q').value.trim(); if (q) runSearch(q); },
  'doc-search'() { runSearch($('#search-q').value.trim()); },
  'viewer-search'() {
    const q = $('#viewer-q').value.trim();
    if (V.hits && q === V.lastQ && V.hits.length) {
      V.hitIdx = (V.hitIdx + 1) % V.hits.length;
      return goToPage(V.hits[V.hitIdx].page);
    }
    V.lastQ = q;
    viewerSearch(q);
  },
};

const cleanErr = (e) => String(e && e.message ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// ---------- Navbar ----------
function renderNav() {
  const nav = $('#nav');
  if (!nav || !S.data) return;
  const site = S.data.site || {};
  const r = S.route.name;
  const unread = (S.data.notifications || []).filter((n) => !n.read).length + (S.data.newItems || []).length;
  nav.innerHTML = `
    <div class="brand" data-action="go" data-route="dashboard">
      <div class="brand-mark">${icon('graduation')}</div><b>${esc(site.sitename || 'Chadoodle')}</b>
    </div>
    <nav class="primary-nav">
      <a href="#" data-action="go" data-route="dashboard" class="${r === 'dashboard' ? 'active' : ''}">Dashboard</a>
      <a href="#" data-action="go" data-route="courses" class="${['courses', 'course', 'module'].includes(r) ? 'active' : ''}">Meine Kurse</a>
      <a href="#" data-action="go" data-route="events" class="${r === 'events' ? 'active' : ''}">Termine</a>
      <a href="#" data-action="go" data-route="timetable" class="${r === 'timetable' ? 'active' : ''}">Stundenplan</a>
      <a href="#" data-action="go" data-route="mensa" class="${r === 'mensa' ? 'active' : ''}">Mensa</a>
    </nav>
    <form class="nav-search" data-submit="nav-search"><div class="input-icon">${icon('search', 'sm')}<input id="nav-q" class="input" placeholder="In Dokumenten suchen…" title="Strg+Umschalt+F" value="${esc(r === 'search' ? S.route.params.q || '' : '')}" /></div></form>
    <div class="spacer"></div>
    <div id="sync-pill-wrap"></div>
    <button class="icon-btn" data-action="dropdown" data-dd="notif" title="Mitteilungen">${icon('bell')}${unread ? `<span class="badge-dot">${unread > 99 ? '99+' : unread}</span>` : ''}</button>
    <button class="claude-toggle ${S.ui.claudeOpen ? 'active' : ''}" data-action="toggle-claude" title="KI-Lernassistent (Strg+K)">${icon('sparkles')} Assistent</button>
    <button class="avatar" data-action="dropdown" data-dd="user" title="${esc(site.fullname)}">${site.avatar ? `<img src="${esc(site.avatar)}" alt="" />` : initials(site.fullname)}</button>
    ${S.ui.dropdown ? renderDropdown() : ''}`;
  renderSyncPill();
}

function renderSyncPill() {
  const wrap = $('#sync-pill-wrap');
  if (!wrap) return;
  const st = S.status || {};
  const last = (S.data && S.data.lastSync) || st.lastSync;
  let cls = 'ok', ic = icon('checkcircle', 'sm'), text = `Synchronisiert · ${relTime(last)}`;
  if (st.state === 'syncing' || st.state === 'downloading') {
    cls = 'busy';
    ic = icon('refresh', 'sm spin');
    text = st.total ? `${st.state === 'downloading' ? 'Dateien' : 'Sync'} ${st.done}/${st.total}` : st.message || 'Synchronisiere…';
  } else if (st.state === 'error') {
    cls = 'err';
    ic = icon('cloudoff', 'sm');
    text = st.message || 'Fehler';
  } else if (!last) {
    text = 'Noch nicht synchronisiert';
  }
  wrap.innerHTML = `<button class="sync-pill ${cls}" data-action="sync" title="${esc(st.message || '')} – Klicken zum Synchronisieren">${ic}<span>${esc(text)}</span></button>`;
}

function renderDropdown() {
  const d = S.data;
  if (S.ui.dropdown === 'user') {
    const site = d.site || {};
    return `<div class="dropdown" style="width:290px">
      <div class="dd-user"><div class="avatar">${site.avatar ? `<img src="${esc(site.avatar)}" alt="" />` : initials(site.fullname)}</div><div><b>${esc(site.fullname)}</b><small class="muted" style="display:block">${esc(site.sitename)}</small><small class="muted" style="display:block">Chadoodle ${esc(S.state.version)}</small></div></div>
      <div class="dd-sep"></div>
      <a class="dd-item" data-action="go" data-route="settings">${icon('settings')}<div>Einstellungen</div></a>
      <a class="dd-item" data-action="open-folder">${icon('folder')}<div>Download-Ordner öffnen</div></a>
      <a class="dd-item" data-action="open-site">${icon('external')}<div>Moodle im Browser öffnen</div></a>
      <div class="dd-sep"></div>
      <a class="dd-item" data-action="logout">${icon('logout')}<div>Abmelden</div></a>
    </div>`;
  }
  const newFiles = (d.newItems || []).filter((x) => x.type === 'file' && d.files[x.fileId]).slice(0, 8);
  const notes = (d.notifications || []).slice(0, 12);
  return `<div class="dropdown" style="right:120px">
    <div class="dd-head"><b>Mitteilungen</b>${newFiles.length ? '<button class="btn ghost sm" data-action="clear-news">Neue Dateien als gelesen markieren</button>' : ''}</div>
    ${newFiles.map((x) => { const f = d.files[x.fileId]; const k = courseById(f.courseId); return `<a class="dd-item unread" data-action="open-file" data-file="${f.id}">${icon('download')}<div><b>${esc(f.filename)}</b><small>Neue Datei · ${esc(k ? k.shortname || k.fullname : '')} · ${relTime(x.time)}</small></div></a>`; }).join('')}
    ${newFiles.length && notes.length ? '<div class="dd-sep"></div>' : ''}
    ${notes.map((n) => `<a class="dd-item ${n.read ? '' : 'unread'}" ${n.url ? `data-action="external" data-url="${esc(n.url)}"` : ''}>${icon('bell')}<div><b>${esc(n.subject)}</b><small>${fmtDateTime(n.time)}</small></div></a>`).join('')}
    ${!newFiles.length && !notes.length ? `<div class="empty">${icon('bell')}<div>Keine Mitteilungen</div></div>` : ''}
  </div>`;
}

// ---------- Linke Leiste (Kursindex) ----------
function currentCourseId() {
  if (S.route.name === 'course') return Number(S.route.params.id);
  if (S.route.name === 'module') return Number(S.route.params.courseId);
  return null;
}

function renderLeft() {
  const left = $('#left');
  if (!left || !S.data) return;
  const cid = currentCourseId();
  const show = !!cid && S.ui.leftOpen;
  left.classList.toggle('closed', !show);
  if (!cid) { left.innerHTML = ''; return; }
  const sections = S.data.contents[cid] || [];
  const activeCm = S.route.name === 'module' ? Number(S.route.params.cmid) : null;
  left.innerHTML = `
    <div class="ci-head"><b>Kursindex</b><button class="icon-btn sm" data-action="toggle-left" title="Kursindex schließen">${icon('chevleft')}</button></div>
    ${sections.map((s) => {
      const key = `ci-${cid}-${s.id}`;
      const mods = s.modules.filter((m) => m.modname !== 'label');
      return `<div class="ci-section ${S.ui.collapsed[key] ? 'collapsed' : ''}">
        <button data-action="ci-toggle" data-key="${key}" data-section="${s.id}">${icon('chevdown', 'sm')}<span>${esc(s.name || 'Abschnitt ' + s.section)}</span></button>
        <ul>${mods.map((m) => `<li><a href="#" data-action="module" data-cmid="${m.id}" class="${activeCm === m.id ? 'active' : ''}"><i class="ci-dot c-${modInfo(m).purpose}"></i><span>${esc(m.name)}</span></a></li>`).join('')}</ul>
      </div>`;
    }).join('')}`;
}

// ---------- Hauptbereich ----------
function renderMain() {
  const main = $('#main');
  if (!main || !S.data) return;
  // Den Viewer bei Daten-Updates nicht neu aufbauen (Scrollposition/Zoom bleiben)
  if (S.route.name === 'viewer' && V.mountedFor === S.route.params.fileId && $('#viewer-scroll')) return;
  const active = document.activeElement;
  const keepId = active && main.contains(active) && active.id ? active.id : null;
  const sel = keepId && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;

  const r = S.route;
  let html;
  if (!S.data.site) html = renderFirstSync();
  else if (r.name === 'dashboard') html = renderDashboard();
  else if (r.name === 'courses') html = renderCourses();
  else if (r.name === 'course') html = renderCourse();
  else if (r.name === 'module') html = renderModule();
  else if (r.name === 'events') html = renderEventsPage();
  else if (r.name === 'timetable') html = renderTimetable();
  else if (r.name === 'mensa') html = renderMensa();
  else if (r.name === 'settings') html = renderSettings();
  else if (r.name === 'viewer') html = renderViewer();
  else if (r.name === 'search') html = renderSearch();
  const cid = currentCourseId();
  main.innerHTML = (cid && !S.ui.leftOpen ? `<button class="icon-btn drawer-toggle" data-action="toggle-left" title="Kursindex öffnen">${icon('sidebar')}</button>` : '') + html;

  main.classList.toggle('no-scroll', r.name === 'viewer');
  if (r.name === 'viewer') mountViewer();
  if (keepId) {
    const el = document.getElementById(keepId);
    if (el) { el.focus(); if (sel) try { el.setSelectionRange(sel[0], sel[1]); } catch {} }
  }
}

function go(name, params = {}, { back = false } = {}) {
  if (S.route.name === 'viewer') unmountViewer();
  const same = S.route.name === name && JSON.stringify(S.route.params) === JSON.stringify(params);
  if (!back && !same) {
    S.history.push(S.route);
    if (S.history.length > 50) S.history.shift();
  }
  S.prevRoute = S.route;
  S.route = { name, params };
  S.ui.dropdown = null;
  renderNav();
  renderLeft();
  renderMain();
  renderClaudeContext();
  $('#main').scrollTop = 0;
}

// Zurück: Verlauf, sonst eine Ebene höher (Aktivität → Kurs → Kursübersicht → Dashboard)
function goBack() {
  const prev = S.history.pop();
  if (prev) return go(prev.name, prev.params, { back: true });
  const r = S.route;
  if (r.name === 'module') return go('course', { id: r.params.courseId, tab: 'content' }, { back: true });
  if (r.name === 'course') return go('courses', {}, { back: true });
  go('dashboard', {}, { back: true });
}

function backButton(label, action, attrs = '') {
  return `<button class="back-btn" data-action="${action}" ${attrs}>${icon('chevleft', 'sm')}<span>${esc(label)}</span></button>`;
}

function renderFirstSync() {
  const st = S.status || {};
  return `<div class="page"><div class="card" style="max-width:520px;margin:80px auto;text-align:center;padding:36px">
    <div class="brand-mark" style="margin:0 auto 16px;width:56px;height:56px;border-radius:16px">${icon('refresh', 'lg spin')}</div>
    <h2 style="font-size:20px;margin-bottom:6px">Erste Synchronisation…</h2>
    <p class="muted">${esc(st.message || 'Verbinde mit Moodle')}</p>
    ${st.total ? `<div class="progress" style="margin-top:14px"><i style="width:${Math.round((st.done / st.total) * 100)}%"></i></div>` : ''}
  </div></div>`;
}

// Zeitleiste
function timelineHtml(events, { showCourse = true, emptyText = 'Keine anstehenden Aktivitäten' } = {}) {
  if (!events.length) return `<div class="empty">${icon('calendar')}<div>${emptyText}</div></div>`;
  const groups = [];
  for (const e of events) {
    const label = e.overdue || e.timesort < Date.now() / 1000 ? 'Überfällig' : dayLabel(e.timesort);
    let g = groups.find((x) => x.label === label);
    if (!g) groups.push((g = { label, items: [] }));
    g.items.push(e);
  }
  return groups.map((g) => `
    <div class="tl-group"><div class="tl-date" ${g.label === 'Überfällig' ? 'style="color:var(--danger)"' : ''}>${esc(g.label)}</div>
    ${g.items.map((e) => {
      const m = e.cmid ? findModule(e.cmid) : null;
      const due = dueIn(e.timesort);
      return `<div class="tl-item" ${m ? `data-action="module" data-cmid="${e.cmid}"` : e.url ? `data-action="external" data-url="${esc(e.url)}"` : ''}>
        <div class="time">${fmtTime(e.timesort)}</div>
        ${actIcon(m ? m.mod : { modname: e.modulename }, 'sm')}
        <div class="grow"><b>${esc(e.activityname || e.name)}</b><small>${esc(e.name)}${showCourse ? ' · ' + esc(e.coursename) : ''}</small></div>
        <span class="chip ${due.cls}">${due.text}</span>
      </div>`;
    }).join('')}</div>`).join('');
}

function renderDashboard() {
  const d = S.data;
  const now = Date.now() / 1000;
  const range = S.ui.tlRange;
  const events = d.events.filter((e) => range === 'all' || e.timesort <= now + Number(range) * 86400);
  const week = d.events.filter((e) => e.timesort > now && e.timesort <= now + 7 * 86400).length;
  const files = Object.values(d.files);
  const local = files.filter((f) => f.downloaded).length;
  const recent = [...d.courses].sort((a, b) => (b.lastaccess || 0) - (a.lastaccess || 0)).slice(0, 4);
  const news = (d.newItems || []).filter((x) => x.type === 'file' && d.files[x.fileId]).slice(0, 8);
  const hour = new Date().getHours();
  const greet = hour < 11 ? 'Guten Morgen' : hour < 18 ? 'Hallo' : 'Guten Abend';

  return `<div class="page wide">
    <section class="hero">
      <h1>${greet}, ${esc(d.site.firstname || d.site.fullname)}! 👋</h1>
      <p>${new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p>
      <div class="hero-stats">
        <div class="hero-stat"><b>${d.courses.length}</b><small>Kurse</small></div>
        <div class="hero-stat"><b>${week}</b><small>fällig in 7 Tagen</small></div>
        <div class="hero-stat"><b>${news.length}</b><small>neue Dateien</small></div>
        <div class="hero-stat"><b>${local}/${files.length}</b><small>Dateien lokal</small></div>
      </div>
    </section>
    <div class="grid-dash">
      <div class="stack">
        <div class="card">
          <div class="card-head"><h2>${icon('clock')} Zeitleiste</h2>
            <div class="segmented">${[['7', '7 Tage'], ['30', '30 Tage'], ['all', 'Alle']].map(([v, l]) => `<button class="${range === v ? 'on' : ''}" data-action="tl-range" data-v="${v}">${l}</button>`).join('')}</div>
          </div>
          <div class="card-body">${timelineHtml(events)}</div>
        </div>
        <div class="card">
          <div class="card-head"><h2>${icon('book')} Zuletzt besuchte Kurse</h2><button class="btn ghost sm" data-action="go" data-route="courses">Alle Kurse ${icon('chevright', 'sm')}</button></div>
          <div class="card-body"><div class="course-grid recent">${recent.map(courseCard).join('') || '<div class="empty">Keine Kurse</div>'}</div></div>
        </div>
      </div>
      <div class="stack">
        <div class="card">
          <div class="card-head"><h2>${icon('download')} Neu synchronisiert</h2>${news.length ? '<button class="btn ghost sm" data-action="clear-news">Gelesen</button>' : ''}</div>
          <div class="card-body">${news.length ? news.map((x) => { const f = d.files[x.fileId]; const k = courseById(f.courseId); return fileLine(f, k ? k.shortname || k.fullname : ''); }).join('') : `<div class="empty">${icon('checkcircle')}<div>Keine neuen Dateien seit der letzten Durchsicht</div></div>`}</div>
        </div>
        <div class="card" style="background:var(--claude-soft);border-color:color-mix(in srgb,var(--claude) 25%,var(--border))">
          <div class="card-body" style="padding:18px">
            <div style="display:flex;gap:12px;align-items:center;margin-bottom:10px"><div class="cp-logo">${icon('sparkles')}</div><b style="font-size:15.5px">Frag die KI zu deinen Unterlagen</b></div>
            <p class="muted small" style="margin:0 0 12px">Der Assistent durchsucht alle synchronisierten Skripte, Folien und Aufgaben, findet die Stellen und erklärt sie.</p>
            <div class="suggestions">
              ${['Was muss ich diese Woche erledigen?', 'Was ist neu in meinen Kursen und worum geht es darin?', 'Erstelle mir einen Lernplan für die nächsten 2 Wochen.'].map((q) => `<div class="suggestion" data-action="ask" data-q="${esc(q)}">${icon('sparkles', 'sm')}${esc(q)}</div>`).join('')}
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h2>${icon('hd')} Lokale Kopie</h2></div>
          <div class="card-body">
            <dl class="kv small">
              <dt>Letzter Sync</dt><dd>${relTime(d.lastSync)}</dd>
              <dt>Dateien lokal</dt><dd>${local} von ${files.length} (${fmtSize(files.filter((f) => f.downloaded).reduce((s, f) => s + (f.filesize || 0), 0)) || '0 KB'})</dd>
              <dt>Intervall</dt><dd>alle ${S.state.settings.syncIntervalMin} Min.</dd>
              <dt>Volltextindex</dt><dd id="index-status">${indexText()}</dd>
            </dl>
            <div style="display:flex;gap:8px;margin-top:14px"><button class="btn sm" data-action="sync">${icon('refresh', 'sm')} Jetzt synchronisieren</button><button class="btn sm ghost" data-action="open-folder">${icon('folder', 'sm')} Ordner</button></div>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

function fileLine(f, sub = '') {
  const st = f.downloaded ? `<span class="state ok" title="Lokal verfügbar">${icon('check', 'sm')}</span>` : f.error ? `<span class="state err" title="${esc(f.error)}">${icon('alert', 'sm')}</span>` : `<span class="state" title="Noch nicht heruntergeladen">${icon('cloud', 'sm')}</span>`;
  return `<div class="file-line" data-action="open-file" data-file="${f.id}" title="${esc(f.localPath)}">
    ${icon(/\.(pdf|docx?|txt|md|pptx?)$/i.test(f.filename) ? 'filetext' : 'file', 'sm')}
    <div class="grow">${esc(f.filename)}${sub ? ` <span class="muted small">· ${esc(sub)}</span>` : ''}</div>
    <span class="muted small">${fmtSize(f.filesize)}</span>${st}
    <button class="icon-btn sm claude-mini" data-action="ask-file" data-file="${f.id}" title="Mit KI besprechen">${icon('sparkles', 'sm')}</button>
    <button class="icon-btn sm" data-action="show-file" data-file="${f.id}" title="Im Ordner zeigen">${icon('folder', 'sm')}</button>
  </div>`;
}

function courseCard(k) {
  return `<div class="course-card" data-action="course" data-id="${k.id}">
    <div class="course-img" style='${courseBg(k)}'>${k.isfavourite ? `<span class="fav">${icon('star', 'sm')}</span>` : ''}</div>
    <div class="course-info">
      <div class="cat">${esc(k.categoryname || k.shortname)}</div>
      <h3>${esc(k.fullname)}</h3>
      <div class="meta">${k.progress != null ? `<div class="progress"><i style="width:${Math.round(k.progress)}%"></i></div><span>${Math.round(k.progress)}%</span>` : `<span>${esc(k.shortname)}</span>`}</div>
    </div>
  </div>`;
}

function renderCourses() {
  const now = Date.now() / 1000;
  const q = S.ui.courseSearch.toLowerCase();
  const f = S.ui.courseFilter;
  let list = courses().filter((k) => {
    if (q && !(`${k.fullname} ${k.shortname} ${k.categoryname || ''}`.toLowerCase().includes(q))) return false;
    if (f === 'fav') return k.isfavourite;
    const started = !k.startdate || k.startdate <= now;
    const ended = k.enddate && k.enddate < now;
    if (f === 'inprogress') return started && !ended;
    if (f === 'future') return !started;
    if (f === 'past') return ended;
    return true;
  });
  list.sort(S.ui.courseSort === 'name' ? (a, b) => a.fullname.localeCompare(b.fullname, 'de') : (a, b) => (b.lastaccess || 0) - (a.lastaccess || 0));
  const filters = [['all', 'Alle'], ['inprogress', 'Laufend'], ['future', 'Zukünftig'], ['past', 'Vergangen'], ['fav', 'Favoriten']];

  return `<div class="page wide">
    <div class="page-head"><div><h1>Meine Kurse</h1><p>${courses().length} Kurse · lokal synchronisiert</p></div></div>
    <div class="toolbar">
      <div class="input-icon">${icon('search')}<input id="course-search" class="input" placeholder="Kurse durchsuchen…" value="${esc(S.ui.courseSearch)}" data-input="course-search" /></div>
      <div class="segmented">${filters.map(([v, l]) => `<button class="${f === v ? 'on' : ''}" data-action="course-filter" data-v="${v}">${l}</button>`).join('')}</div>
      <select class="select" data-change="course-sort"><option value="access" ${S.ui.courseSort === 'access' ? 'selected' : ''}>Letzter Zugriff</option><option value="name" ${S.ui.courseSort === 'name' ? 'selected' : ''}>Kursname</option></select>
      <div class="segmented"><button class="${S.ui.courseView === 'cards' ? 'on' : ''}" data-action="course-view" data-v="cards" title="Kacheln">${icon('grid', 'sm')}</button><button class="${S.ui.courseView === 'list' ? 'on' : ''}" data-action="course-view" data-v="list" title="Liste">${icon('list', 'sm')}</button></div>
    </div>
    ${!list.length ? `<div class="card empty">${icon('book')}<div>Keine Kurse für diesen Filter</div></div>`
      : S.ui.courseView === 'cards' ? `<div class="course-grid">${list.map(courseCard).join('')}</div>`
      : `<div class="course-list">${list.map((k) => `<div class="course-row" data-action="course" data-id="${k.id}"><div class="thumb" style='${courseBg(k)}'></div><div class="grow"><div class="muted small">${esc(k.categoryname || k.shortname)}</div><h3>${esc(k.fullname)}</h3></div>${k.progress != null ? `<div style="width:140px;display:flex;gap:8px;align-items:center" class="small muted"><div class="progress"><i style="width:${Math.round(k.progress)}%"></i></div>${Math.round(k.progress)}%</div>` : ''}<span class="muted small" style="width:120px;text-align:right">${k.lastaccess ? 'Zuletzt ' + fmtDate(k.lastaccess) : ''}</span></div>`).join('')}</div>`}
  </div>`;
}

// Kursseite
function renderCourse() {
  const k = courseById(S.route.params.id);
  if (!k) return `<div class="page"><div class="card empty">Kurs nicht gefunden</div></div>`;
  const tab = S.route.params.tab || 'content';
  const sections = S.data.contents[k.id] || [];
  const files = Object.values(S.data.files).filter((f) => f.courseId === k.id);
  const evs = S.data.events.filter((e) => e.courseid === k.id);
  const tabs = [['content', 'Kurs', 'book'], ['events', 'Termine', 'calendar', evs.length], ['grades', 'Bewertungen', 'award'], ['files', 'Dateien', 'folder', files.length]];

  let body = '';
  if (tab === 'content') {
    const allCollapsed = sections.every((s) => S.ui.collapsed[`s-${k.id}-${s.id}`]);
    body = `<div style="display:flex;justify-content:flex-end;gap:8px;margin:-6px 0 12px">
        <button class="btn sm ghost" data-action="collapse-all" data-id="${k.id}" data-v="${allCollapsed ? '0' : '1'}">${allCollapsed ? 'Alle aufklappen' : 'Alle einklappen'}</button>
      </div>` + sections.map((s) => sectionHtml(k, s)).join('');
  } else if (tab === 'events') {
    const assigns = Object.entries(S.data.assignments).filter(([, a]) => a.courseid === k.id).sort((a, b) => (a[1].duedate || 9e9) - (b[1].duedate || 9e9));
    body = `<div class="grid-dash">
      <div class="card"><div class="card-head"><h2>${icon('clock')} Anstehend</h2></div><div class="card-body">${timelineHtml(evs, { showCourse: false })}</div></div>
      <div class="card"><div class="card-head"><h2>${icon('clipboard')} Alle Aufgaben</h2></div><div class="card-body">${assigns.length ? assigns.map(([cmid, a]) => {
        const due = a.duedate ? dueIn(a.duedate) : null;
        return `<div class="tl-item" data-action="module" data-cmid="${cmid}">${actIcon({ modname: 'assign' }, 'sm')}<div class="grow"><b>${esc(a.name)}</b><small>${a.duedate ? 'Fällig ' + fmtDateTime(a.duedate) : 'Kein Fälligkeitsdatum'}</small></div>${due && a.duedate > Date.now() / 1000 ? `<span class="chip ${due.cls}">${due.text}</span>` : a.duedate ? '<span class="chip">vorbei</span>' : ''}</div>`;
      }).join('') : `<div class="empty">${icon('clipboard')}<div>Keine Aufgaben</div></div>`}</div></div>
    </div>`;
  } else if (tab === 'grades') {
    const g = S.data.grades[k.id] || [];
    body = `<div class="card">${g.length ? `<table class="table"><thead><tr><th>Bewertungsaspekt</th><th>Bewertung</th><th>Bereich</th><th>Prozent</th><th>Feedback</th></tr></thead><tbody>
      ${g.map((it) => `<tr class="${it.itemtype === 'course' ? 'total' : ''}"><td>${it.cmid ? `<a href="#" data-action="module" data-cmid="${it.cmid}">${esc(strip(it.name))}</a>` : esc(strip(it.name))}</td><td>${esc(it.grade || '–')}</td><td class="muted">${esc(it.range || '')}</td><td>${esc(it.percentage || '')}</td><td class="rich small">${clean(it.feedback)}</td></tr>`).join('')}
    </tbody></table>` : `<div class="empty">${icon('award')}<div>Noch keine Bewertungen</div></div>`}</div>`;
  } else if (tab === 'files') {
    const q = S.ui.fileSearch.toLowerCase();
    const list = files.filter((f) => !q || `${f.filename} ${f.moduleName} ${f.section}`.toLowerCase().includes(q)).sort((a, b) => (b.timemodified || 0) - (a.timemodified || 0));
    const missing = files.filter((f) => !f.downloaded).length;
    body = `<div class="toolbar">
        <div class="input-icon">${icon('search')}<input id="file-search" class="input" placeholder="Dateien durchsuchen…" value="${esc(S.ui.fileSearch)}" data-input="file-search" /></div>
        <button class="btn sm" data-action="open-folder" data-id="${k.id}">${icon('folder', 'sm')} Kursordner öffnen</button>
        ${missing ? `<button class="btn sm" data-action="download-missing" data-id="${k.id}">${icon('download', 'sm')} ${missing} fehlende laden</button>` : ''}
      </div>
      <div class="card"><table class="table"><thead><tr><th>Name</th><th>Abschnitt</th><th>Größe</th><th>Geändert</th><th></th></tr></thead><tbody>
      ${list.map((f) => `<tr><td><a href="#" data-action="open-file" data-file="${f.id}">${esc(f.filename)}</a><div class="muted small">${esc(f.moduleName)}</div></td><td class="muted small">${esc(f.section.replace(/^\d+ /, ''))}</td><td class="small">${fmtSize(f.filesize)}</td><td class="small">${fmtDate(f.timemodified)}</td>
        <td style="white-space:nowrap;text-align:right">${f.downloaded ? `<span class="chip ok">${icon('check', 'sm')} lokal</span>` : f.error ? `<span class="chip warn" title="${esc(f.error)}">Fehler</span>` : '<span class="chip">online</span>'}
        <button class="icon-btn sm claude-mini" data-action="ask-file" data-file="${f.id}" title="Mit KI besprechen">${icon('sparkles', 'sm')}</button><button class="icon-btn sm" data-action="show-file" data-file="${f.id}" title="Im Ordner zeigen">${icon('folder', 'sm')}</button></td></tr>`).join('')}
      </tbody></table>${!list.length ? `<div class="empty">${icon('folder')}<div>Keine Dateien</div></div>` : ''}</div>`;
  }

  return `<div class="page">
    <div class="page-top">${backButton('Kursübersicht', 'go', 'data-route="courses"')}<div class="crumbs"><a href="#" data-action="go" data-route="courses">Meine Kurse</a>${icon('chevright')}<span>${esc(k.shortname)}</span></div></div>
    <div class="course-banner" style='${courseBg(k)}'>
      <div class="inner"><div><div class="cat">${esc(k.categoryname || k.shortname)}</div><h1>${esc(k.fullname)}</h1></div>
      <div style="display:flex;gap:8px"><button class="btn sm" data-action="ask" data-q="Gib mir einen Überblick über diesen Kurs: Inhalte, wichtige Materialien und was als Nächstes ansteht.">${icon('sparkles', 'sm')} Überblick</button><button class="btn sm" data-action="open-folder" data-id="${k.id}">${icon('folder', 'sm')} Ordner</button><button class="btn sm" data-action="external" data-url="${esc(S.data.site.url)}/course/view.php?id=${k.id}">${icon('external', 'sm')}</button></div></div>
    </div>
    <div class="tabs">${tabs.map(([v, l, ic, n]) => `<a href="#" class="${tab === v ? 'active' : ''}" data-action="course-tab" data-v="${v}">${icon(ic, 'sm')} ${l}${n ? ` <span class="count">${n}</span>` : ''}</a>`).join('')}</div>
    ${body}
  </div>`;
}

function sectionHtml(k, s) {
  const key = `s-${k.id}-${s.id}`;
  const collapsed = !!S.ui.collapsed[key];
  const mods = s.modules;
  if (!mods.length && !strip(s.summary) && s.section !== 0) return '';
  return `<div class="card section ${collapsed ? 'collapsed' : ''}" id="sec-${s.id}">
    <div class="section-head" data-action="section-toggle" data-key="${key}">
      <span class="chev">${icon('chevdown', 'sm')}</span>
      <h2>${esc(s.name || 'Abschnitt ' + s.section)}</h2>
      <span class="muted">${mods.filter((m) => m.modname !== 'label').length} Aktivitäten</span>
    </div>
    <div class="section-body">
      ${strip(s.summary) ? `<div class="section-summary rich">${clean(s.summary)}</div>` : ''}
      ${mods.map((m) => activityHtml(m)).join('')}
    </div>
  </div>`;
}

function activityHtml(m) {
  const info = modInfo(m);
  const dim = m.uservisible === false ? 'dim' : '';
  if (m.modname === 'label') return `<div class="activity label-act ${dim}"><div class="rich">${clean(m.description)}</div></div>`;
  const files = filesOfModule(m);
  const a = S.data.assignments[m.id];
  const chips = [];
  if (a && a.duedate) {
    const due = dueIn(a.duedate);
    chips.push(`<span class="chip ${a.duedate > Date.now() / 1000 ? due.cls : ''}">${icon('clock', 'sm')} Fällig: ${fmtDateTime(a.duedate)}</span>`);
  } else if (m.dates && m.dates.length) {
    for (const dt of m.dates.slice(0, 2)) chips.push(`<span class="chip">${esc(dt.label)} ${fmtDateTime(dt.timestamp)}</span>`);
  }
  if (m.completion === 1 || m.completion === 2) chips.push(`<span class="chip ok">${icon('check', 'sm')} Erledigt</span>`);
  if (m.uservisible === false) chips.push('<span class="chip">Nicht verfügbar</span>');

  let state = '';
  if (m.modname === 'resource' && files.length === 1) {
    const f = files[0];
    state = f.downloaded ? `<span class="state ok">${icon('check', 'sm')} ${fmtSize(f.filesize)}</span>` : f.error ? `<span class="state err" title="${esc(f.error)}">${icon('alert', 'sm')} Fehler</span>` : `<span class="state">${icon('cloud', 'sm')} ${fmtSize(f.filesize)}</span>`;
  } else if (m.modname === 'folder') {
    state = `<span class="state">${files.length} Dateien</span>`;
  }
  const ext = m.modname === 'resource' && files[0] ? files[0].filename.split('.').pop().toUpperCase() : '';
  const openFolder = m.modname === 'folder' && S.ui.openFolders[m.id];

  return `<div class="activity ${dim}" data-action="activity" data-cmid="${m.id}">
      ${actIcon(m)}
      <div class="grow">
        <div class="type">${esc(info.label)}${ext && ext.length <= 5 ? ' · ' + esc(ext) : ''}</div>
        <span class="name">${esc(m.name)}</span>
        ${chips.length ? `<div class="dates">${chips.join('')}</div>` : ''}
      </div>
      <div class="actions">
        ${files.length || ['page', 'assign', 'forum'].includes(m.modname) ? `<button class="icon-btn sm claude-mini" data-action="${files.length === 1 ? 'ask-file' : 'ask-module'}" data-file="${files[0] ? files[0].id : ''}" data-cmid="${m.id}" title="Mit KI besprechen">${icon('sparkles', 'sm')}</button>` : ''}
        ${files.length === 1 ? `<button class="icon-btn sm" data-action="show-file" data-file="${files[0].id}" title="Im Ordner zeigen">${icon('folder', 'sm')}</button>` : ''}
        ${m.url ? `<button class="icon-btn sm" data-action="external" data-url="${esc(m.url)}" title="In Moodle öffnen">${icon('external', 'sm')}</button>` : ''}
      </div>
      ${state}
      ${m.modname === 'folder' ? `<span class="chev" style="display:grid;transform:rotate(${openFolder ? 0 : -90}deg);transition:transform .15s">${icon('chevdown', 'sm')}</span>` : ''}
    </div>
    ${openFolder ? `<div class="folder-files">${files.map((f) => fileLine(f, (f.filepath || '/') !== '/' ? f.filepath : '')).join('') || '<div class="muted small">Leer</div>'}</div>` : ''}`;
}

// Aktivitäts-Detailansicht
function renderModule() {
  const hit = findModule(S.route.params.cmid);
  if (!hit) return `<div class="page"><div class="card empty">Aktivität nicht gefunden</div></div>`;
  const { mod: m, section: s, courseId } = hit;
  const k = courseById(courseId);
  const info = modInfo(m);
  const files = filesOfModule(m);
  const a = S.data.assignments[m.id];
  const page = S.data.pages[m.id];
  const forum = S.data.forums[m.id];
  const blocks = [];

  if (a) {
    const due = a.duedate ? dueIn(a.duedate) : null;
    blocks.push(`<div class="card"><div class="card-body" style="padding-top:18px">
      <dl class="kv">
        ${a.allowsubmissionsfromdate ? `<dt>Geöffnet</dt><dd>${fmtDateTime(a.allowsubmissionsfromdate)}</dd>` : ''}
        <dt>Fällig</dt><dd>${a.duedate ? fmtDateTime(a.duedate) + ` <span class="chip ${a.duedate > Date.now() / 1000 ? due.cls : ''}" style="margin-left:6px">${a.duedate > Date.now() / 1000 ? due.text : 'abgelaufen'}</span>` : 'Kein Fälligkeitsdatum'}</dd>
        ${a.cutoffdate ? `<dt>Letzte Abgabe</dt><dd>${fmtDateTime(a.cutoffdate)}</dd>` : ''}
      </dl></div></div>`);
    if (strip(a.intro)) blocks.push(`<div class="card"><div class="card-head"><h2>Aufgabenstellung</h2></div><div class="card-body rich">${clean(a.intro)}</div></div>`);
  } else if (strip(m.description) && !page) {
    blocks.push(`<div class="card"><div class="card-body rich" style="padding-top:18px">${clean(m.description)}</div></div>`);
  }
  if (page) blocks.push(`<div class="card"><div class="card-body rich" style="padding:22px 24px">${clean(page.content)}</div></div>`);
  if (forum) {
    blocks.push(`<div class="card"><div class="card-head"><h2>${icon('message')} Diskussionen</h2><span class="muted small">neueste ${forum.discussions.length}</span></div><div class="card-body">
      ${forum.discussions.length ? forum.discussions.map((d) => `<div class="discussion"><h3>${d.pinned ? icon('pin', 'sm') + ' ' : ''}${esc(d.subject)}</h3><div class="by">${esc(d.author)} · ${fmtDateTime(d.created)}${d.replies ? ` · ${d.replies} Antworten` : ''}</div><div class="rich">${clean(d.message)}</div></div>`).join('') : `<div class="empty">${icon('message')}<div>Noch keine Beiträge</div></div>`}
    </div></div>`);
  }
  if (m.modname === 'url' && m.contents[0]) {
    blocks.push(`<div class="card"><div class="card-body" style="padding-top:18px"><a href="#" data-action="external" data-url="${esc(m.contents[0].fileurl)}">${icon('link', 'sm')} ${esc(m.contents[0].fileurl)}</a></div></div>`);
  }
  if (files.length) blocks.push(`<div class="card"><div class="card-head"><h2>${icon('folder')} Dateien</h2></div><div class="card-body">${files.map((f) => fileLine(f)).join('')}</div></div>`);
  if (!blocks.length) {
    blocks.push(`<div class="card empty">${icon(info.icon)}<div>Diese Aktivität (${esc(info.label)}) gibt es nur online in Moodle.</div><button class="btn primary" style="margin-top:14px" data-action="external" data-url="${esc(m.url)}">${icon('external', 'sm')} In Moodle öffnen</button></div>`);
  }

  return `<div class="page">
    <div class="page-top">${backButton(k ? k.shortname || 'Zum Kurs' : 'Zum Kurs', 'course', `data-id="${courseId}"`)}<div class="crumbs"><a href="#" data-action="go" data-route="courses">Meine Kurse</a>${icon('chevright')}<a href="#" data-action="course" data-id="${courseId}">${esc(k ? k.shortname : '')}</a>${icon('chevright')}<span>${esc(s.name)}</span></div></div>
    <div class="detail-head">${actIcon(m)}<div style="flex:1;min-width:0"><div class="type muted small" style="font-weight:700;text-transform:uppercase;letter-spacing:.05em">${esc(info.label)}</div><h1>${esc(m.name)}</h1></div>
      <button class="btn claude" data-action="${files.length === 1 ? 'ask-file' : 'ask-module'}" data-file="${files[0] ? files[0].id : ''}" data-cmid="${m.id}">${icon('sparkles', 'sm')} Mit KI besprechen</button>
      ${m.url ? `<button class="btn" data-action="external" data-url="${esc(m.url)}">${icon('external', 'sm')} ${a ? 'Abgabe in Moodle' : 'In Moodle öffnen'}</button>` : ''}
    </div>
    <div class="stack">${blocks.join('')}</div>
  </div>`;
}

// ---------- Mensa ----------
const euro = (n) => (n == null ? '' : n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' }));

async function loadMensa(force = false) {
  const m = S.mensa;
  if (m.busy) return;
  m.busy = true;
  if (S.route.name === 'mensa' && force) renderMain();
  try {
    if (!m.url) Object.assign(m, await api.mensaUrl());
    m.data = await api.mensaGet(force);
    m.error = m.data.error || '';
    // Standard: heute, sonst der nächste Tag mit Essen
    if (!m.data.days.some((d) => d.date === m.day)) {
      const today = new Date().toLocaleDateString('sv-SE');
      m.day = (m.data.days.find((d) => d.date >= today) || m.data.days[0] || {}).date || null;
    }
  } catch (e) {
    m.error = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  } finally {
    m.busy = false;
    if (S.route.name === 'mensa') renderMain();
  }
}

// Vorlesungen des gewählten Mensa-Tags aus dem aktiven Stundenplan
async function loadMensaDay() {
  const m = S.mensa;
  const date = m.day;
  if (!date || (m.tt && m.tt.date === date)) return;
  m.tt = { date, loading: true, events: [], plan: null };
  try {
    const r = await api.ttList();
    const plan = r.list.find((x) => x.id === r.active) || r.list[0] || null;
    const start = new Date(`${date}T00:00:00`).getTime();
    const events = plan ? await api.ttEvents(plan.id, start, ttAddDays(start, 1)) : [];
    if (m.day === date) m.tt = { date, loading: false, plan, events: events.filter((e) => !e.allDay && e.start >= start && e.start < ttAddDays(start, 1)) };
  } catch {
    if (m.day === date) m.tt = { date, loading: false, plan: null, events: [] };
  }
  if (S.route.name === 'mensa') renderMain();
}

// Uhrzeit „HH:MM“ an einem Tag → Zeitstempel
const atClock = (dayStart, hm, fallback) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '')) || /^(\d{1,2}):(\d{2})$/.exec(fallback);
  return dayStart + (Number(m[1]) * 60 + Number(m[2])) * 60000;
};

// Mensa-Fenster: Pausen zwischen den Vorlesungen (Überschneidungen zusammengefasst) und die
// Tagesränder. Gültig ist ein Fenster, wenn man innerhalb der Abholzeit abholen kann und ab
// Abholbeginn noch mindestens minBreak Minuten bis zur nächsten Vorlesung bleiben.
function mensaBreaks(events, dayStart, minBreak, pickFrom, pickTo) {
  const iv = events.map((e) => [e.start, e.end]).sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const [s0, e0] of iv) {
    const last = merged[merged.length - 1];
    if (last && s0 <= last[1]) last[1] = Math.max(last[1], e0);
    else merged.push([s0, e0]);
  }
  const need = minBreak * 60000;
  const out = [];
  const add = (start, end, kind) => {
    const from = Math.max(start, pickFrom); // abholen erst ab Öffnung
    const usable = end == null ? Infinity : end - from;
    const reason = from > pickTo ? 'nach der Abholzeit' : end != null && end <= pickFrom ? 'vor der Abholzeit' : usable < need ? 'zu kurz' : '';
    out.push({ start, end, kind, from, ok: !reason, reason });
  };
  for (let i = 1; i < merged.length; i++) if (merged[i][0] > merged[i - 1][1]) add(merged[i - 1][1], merged[i][0], 'between');
  if (merged.length) {
    if (merged[0][0] > pickFrom) add(Math.min(pickFrom, merged[0][0]), merged[0][0], 'before');
    if (merged[merged.length - 1][1] < pickTo) add(merged[merged.length - 1][1], null, 'after');
  }
  return out.sort((x, y) => x.start - y.start);
}

function mensaDayHtml() {
  const m = S.mensa;
  const t = m.tt;
  const st = S.state.settings;
  const minBreak = Math.max(1, Number(st.mensaMinBreak) || 44);
  const controls = `<div class="zu-controls">
      <label title="Abholzeit der Mensa">Abholung <input type="time" class="input" data-change="setting-str" data-key="mensaPickupFrom" value="${esc(st.mensaPickupFrom || '11:45')}" />–<input type="time" class="input" data-change="setting-str" data-key="mensaPickupTo" value="${esc(st.mensaPickupTo || '13:30')}" /></label>
      <label title="So lang muss die Pause ab Abholbeginn mindestens sein">mind. <input type="number" min="10" max="180" step="1" class="input zu-num" data-change="setting-num" data-key="mensaMinBreak" value="${minBreak}" /> Min.</label>
    </div>`;
  const head = (sub) => `<div class="card-head"><h2>${icon('clock')} Zeit für die ZU</h2>${controls}</div><div class="card-body">${sub}`;
  if (!t || t.loading) return `<div class="card zu-card">${head(`<div class="muted small">Lade Stundenplan…</div>`)}</div></div>`;
  if (!t.plan) return `<div class="card zu-card">${head(`<div class="muted small">Kein Stundenplan eingetragen. Füge ihn im Reiter <a href="#" data-action="go" data-route="timetable">Stundenplan</a> hinzu, dann siehst du hier, wann du in die ZU gehen kannst.</div>`)}</div></div>`;

  const dayStart = new Date(`${t.date}T00:00:00`).getTime();
  const pickFrom = atClock(dayStart, st.mensaPickupFrom, '11:45');
  const pickTo = atClock(dayStart, st.mensaPickupTo, '13:30');
  if (!t.events.length) return `<div class="card zu-card">${head(`<div class="zu-free">${icon('checkcircle', 'sm')} Keine Vorlesungen an diesem Tag – Abholung jederzeit zwischen ${ttClock(pickFrom)} und ${ttClock(pickTo)}.</div>`)}</div></div>`;

  const breaks = mensaBreaks(t.events, dayStart, minBreak, pickFrom, pickTo);
  const ok = breaks.filter((x) => x.ok);
  const hourOf = (ms) => (ms - dayStart) / 3600000;
  const from = Math.min(8, Math.floor(hourOf(Math.min(...t.events.map((e) => e.start)))));
  const to = Math.max(18, Math.ceil(hourOf(Math.max(...t.events.map((e) => e.end)))));
  const pos = (ms) => Math.max(0, Math.min(100, ((hourOf(ms) - from) / (to - from)) * 100));
  const mins = (x, y) => Math.round((y - x) / 60000);
  const endOf = (x) => (x.end == null ? Math.max(pickTo, x.start + minBreak * 60000) : x.end);

  const blocks = t.events.map((e) => `<div class="zu-lec" style="left:${pos(e.start)}%;width:${pos(e.end) - pos(e.start)}%" title="${esc(`${e.title}\n${ttClock(e.start)}–${ttClock(e.end)}${e.location ? '\n' + e.location : ''}`)}"><span>${esc(e.title.replace(/\s*\(.*$/, ''))}</span></div>`).join('');
  const gaps = breaks.filter((x) => x.kind === 'between').map((x) => `<div class="zu-gap ${x.ok ? 'ok' : 'short'}" style="left:${pos(x.start)}%;width:${pos(x.end) - pos(x.start)}%" title="${esc(`${ttClock(x.start)}–${ttClock(x.end)} · ${mins(x.start, x.end)} Min.${x.ok ? ' – reicht für die ZU' : ' – ' + x.reason}`)}"><span>${mins(x.start, x.end)}′</span></div>`).join('');
  const band = `<div class="zu-pickup" style="left:${pos(pickFrom)}%;width:${pos(pickTo) - pos(pickFrom)}%" title="Abholzeit ${ttClock(pickFrom)}–${ttClock(pickTo)}"></div>`;
  const ticks = [];
  for (let h = from; h <= to; h += 2) ticks.push(`<span style="left:${pos(dayStart + h * 3600000)}%">${h}</span>`);
  const isToday = t.date === new Date().toLocaleDateString('sv-SE');
  const nowMark = isToday && Date.now() > dayStart + from * 3600000 && Date.now() < dayStart + to * 3600000 ? `<div class="zu-now" style="left:${pos(Date.now())}%"></div>` : '';

  const slot = (x) => {
    const kind = x.kind === 'before' ? 'vor der ersten Vorlesung' : x.kind === 'after' ? 'nach der letzten Vorlesung' : 'Pause';
    const wait = x.from > x.start && x.kind === 'between' ? ` · Abholung ab ${ttClock(x.from)}` : '';
    const time = x.end == null ? `ab ${ttClock(x.from)}` : `${ttClock(x.from)}–${ttClock(x.end)}`;
    const len = x.end == null ? 'open end' : `${mins(x.from, x.end)} Min.`;
    return `<div class="zu-slot">${icon('check', 'sm')}<b>${time}</b><span>${len} · ${kind}${wait}</span></div>`;
  };
  const list = ok.length
    ? ok.map(slot).join('')
    : `<div class="zu-none">${icon('alert', 'sm')} Keine passende Pause: Zwischen ${ttClock(pickFrom)} und ${ttClock(pickTo)} bleiben an diesem Tag nie ${minBreak} Minuten für die ZU.</div>`;

  return `<div class="card zu-card">${head(`
      <div class="zu-strip"><div class="zu-track">${band}${gaps}${blocks}${nowMark}</div><div class="zu-ticks">${ticks.join('')}</div></div>
      <div class="zu-slots">${list}</div>`)}
    </div></div>`;
}

function dishTags(e) {
  const diet = e.tags.filter((t) => t.diet).map((t) => `<span class="diet diet-${esc(t.code.toLowerCase())}">${esc(t.text)}</span>`).join('');
  const allergens = e.tags.filter((t) => !t.diet).map((t) => t.text);
  return { diet, allergens };
}

function renderMensa() {
  const m = S.mensa;
  if (!m.data && !m.error) loadMensa();
  const d = m.data;
  const day = d && d.days.find((x) => x.date === m.day);
  const dayBtn = (x) => {
    const short = x.weekday ? x.weekday.slice(0, 2) : '';
    const rel = /^(heute|morgen)$/i.test(x.rel) ? x.rel[0].toUpperCase() + x.rel.slice(1) : `${short} ${x.label.replace(/^.*?,\s*/, '').replace(/\d{4}$/, '')}`;
    return `<button class="${x.date === m.day ? 'on' : ''}" data-action="mensa-day" data-v="${esc(x.date)}">${esc(rel)}</button>`;
  };

  const head = `<div class="page-head"><div><h1>${esc(d ? d.name : 'Mensa')}</h1><p>${d ? `Speiseplan · Stand ${relTime(d.fetchedAt)}` : 'Speiseplan'}${m.error ? ` · <span style="color:var(--warning)">${esc(m.error)}</span>` : ''}</p></div>
    <div class="tt-nav">
      ${d && d.days.length ? `<div class="segmented">${d.days.map(dayBtn).join('')}</div>` : ''}
      <button class="btn primary sm" data-action="mensa-order" title="Offizielle Bestellseite von my-mensa öffnen">${icon('clipboard', 'sm')} Bestellen</button>
      <button class="icon-btn" data-action="mensa-refresh" title="Jetzt aktualisieren">${icon('refresh', m.busy ? 'spin' : '')}</button>
    </div></div>`;

  let body;
  if (!d && !m.error) body = `<div class="card"><div class="empty">${icon('refresh', 'spin')}<div>Lade Speiseplan…</div></div></div>`;
  else if (!d) body = `<div class="card"><div class="empty">${icon('cloudoff')}<div>Speiseplan konnte nicht geladen werden.</div></div></div>`;
  else if (!day) body = `<div class="card"><div class="empty">${icon('calendar')}<div>Für die nächsten Tage ist noch kein Speiseplan veröffentlicht.</div></div></div>`;
  else {
    if (!m.tt || m.tt.date !== m.day) loadMensaDay();
    body = `<div class="mensa-day-title"><b>${esc(day.weekday || day.label)}</b><span>${esc(day.label.replace(/^.*?,\s*/, ''))}</span></div>
      ${mensaDayHtml()}
      <div class="mensa-grid">${day.dishes.map((e, i) => {
        const { diet, allergens } = dishTags(e);
        return `<article class="dish" data-action="mensa-dish" data-i="${i}">
          <div class="dish-img${e.thumb ? '' : ' noimg'}">${e.thumb ? `<img src="${esc(e.image || e.thumb)}" alt="" loading="lazy" />` : icon('clipboard')}${diet ? `<div class="dish-diet">${diet}</div>` : ''}</div>
          <div class="dish-body">
            <div class="dish-cat">${esc(e.category)}</div>
            <h3>${esc(e.title)}</h3>
            ${e.description ? `<p>${esc(e.description)}</p>` : ''}
            ${allergens.length ? `<div class="dish-allergens" title="Allergene und Kennzeichnungen">${esc(allergens.join(' · '))}</div>` : ''}
            <div class="dish-price">${e.prices.dhbw != null ? `<b>${euro(e.prices.dhbw)}</b><span>DHBW</span>` : ''}<small>${[e.prices.intern != null ? `intern ${euro(e.prices.intern)}` : '', e.prices.extern != null ? `extern ${euro(e.prices.extern)}` : ''].filter(Boolean).join(' · ')}</small></div>
          </div>
        </article>`;
      }).join('')}</div>`;
  }

  const custom = m.url && m.url !== m.defaultUrl;
  const settings = `<div class="card" style="margin-top:22px"><div class="card-head"><h2>${icon('settings')} Mensa</h2>
      <button class="btn ghost sm" data-action="external" data-url="${esc(m.url || '')}">${icon('external', 'sm')} Im Browser öffnen</button></div>
    <div class="card-body">
      <form class="tt-form mensa-form" data-submit="mensa-url">
        <input class="input" id="mensa-url" data-input="mensa-form" placeholder="Link zur Mensa auf my-mensa.de" value="${esc(m.form || m.url || '')}" />
        ${custom ? '<button type="button" class="btn" data-action="mensa-default">Fallenbrunnen</button>' : ''}
        <button class="btn primary" ${m.busy ? 'disabled' : ''}>Übernehmen</button>
      </form>
      <p class="muted small" style="margin:10px 0 0">Funktioniert mit jeder Mensa auf my-mensa.de. Der Speiseplan wird lokal gespeichert und regelmäßig aktualisiert; Fotos werden direkt von my-mensa geladen. Bestellt wird über die offizielle my-mensa-Seite; der Abholschein kommt per E-Mail.</p>
    </div></div>`;

  return `<div class="page wide">${head}${body}${settings}</div>`;
}

// ---------- Stundenplan ----------
const TT_DAY = 86400000;
const TT_HOUR_PX = 54;
const TT_DAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];

function ttMonday(d) {
  const m = new Date(d);
  m.setHours(0, 0, 0, 0);
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
  return m.getTime();
}
// Tage per Kalender addieren (nicht +24 h), damit die Zeitumstellung nichts verschiebt
const ttAddDays = (ms, n) => { const d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime(); };
const ttClock = (ms) => new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const ttHourOf = (ms) => (ms - new Date(ms).setHours(0, 0, 0, 0)) / 3600000;
function ttIsoWeek(ms) {
  const d = new Date(ms);
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  return Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / TT_DAY + 1) / 7);
}
// Gleiche Veranstaltung = gleiche Farbe (Dozentenkürzel in Klammern und Zusätze ignorieren)
function ttColor(title) {
  const base = String(title).replace(/\(.*$/, '').trim().toLowerCase();
  let h = 0;
  for (const c of base) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 8;
}

async function loadTimetable(force = false) {
  const t = S.tt;
  if (!t.list || force) {
    const r = await api.ttList();
    t.list = r.list;
    t.template = r.template;
    t.active = t.list.some((x) => x.id === r.active) ? r.active : t.list[0] ? t.list[0].id : null;
    // Noch nie geladen (z. B. Vorlage beim ersten Start): sofort abrufen statt eine leere Woche zu zeigen
    const plan = t.list.find((x) => x.id === t.active);
    if (plan && !plan.fetchedAt && !t.autoFetched) {
      t.autoFetched = true;
      t.busy = true;
      if (S.route.name === 'timetable') renderMain();
      await api.ttRefresh().catch(() => {});
      t.busy = false;
      return loadTimetable(true);
    }
  }
  const key = `${t.active}|${t.week}`;
  if (force || t.loadedKey !== key) {
    t.loadedKey = key;
    t.events = t.active ? await api.ttEvents(t.active, t.week, ttAddDays(t.week, 7)) : [];
  }
  const thisWeek = ttMonday(new Date());
  const nowKey = `${t.active}|${thisWeek}`;
  if (force || t.nowKey !== nowKey) {
    t.nowKey = nowKey;
    t.nowEvents = !t.active ? [] : t.week === thisWeek ? t.events : await api.ttEvents(t.active, thisWeek, ttAddDays(thisWeek, 7));
  }
  if (S.route.name === 'timetable') renderMain();
}

// Überlappende Termine eines Tages nebeneinander in Spuren anordnen
function ttLayoutDay(list) {
  const items = list.map((e) => ({ e })).sort((a, b) => a.e.start - b.e.start || b.e.end - a.e.end);
  let cluster = [];
  let clusterEnd = 0;
  const flush = () => {
    const lanes = Math.max(1, ...cluster.map((x) => x.lane + 1));
    for (const x of cluster) x.lanes = lanes;
    cluster = [];
  };
  for (const it of items) {
    if (cluster.length && it.e.start >= clusterEnd) flush();
    const used = new Set(cluster.filter((x) => x.e.end > it.e.start).map((x) => x.lane));
    let lane = 0;
    while (used.has(lane)) lane++;
    it.lane = lane;
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.e.end);
  }
  flush();
  return items;
}

// Geschaffte Vorlesungszeit: Überschneidungen zusammenfassen, damit nichts doppelt zählt
function ttDone(events, from, to, now) {
  const iv = events
    .filter((e) => !e.allDay && e.end > from && e.start < to)
    .map((e) => [Math.max(e.start, from), Math.min(e.end, to)])
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [a, b] of iv) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  let total = 0;
  let done = 0;
  for (const [a, b] of merged) {
    total += b - a;
    done += Math.max(0, Math.min(b, now) - a);
  }
  return { total, done, pct: total ? Math.min(100, Math.round((done / total) * 100)) : null };
}

const ttMins = (ms) => {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)} Std. ${m % 60 ? (m % 60) + ' Min.' : ''}`.trim() : `${m} Min.`;
};

function ttProgressHtml() {
  const events = (S.tt.nowEvents || []).filter((e) => !e.allDay);
  const now = Date.now();
  const today = new Date().setHours(0, 0, 0, 0);
  const tomorrow = ttAddDays(today, 1);
  const week = ttMonday(new Date());

  // Stunde: laufende Vorlesung (bei Überschneidung die, die zuerst endet)
  const running = events.filter((e) => e.start <= now && e.end > now).sort((a, b) => a.end - b.end)[0];
  const next = events.filter((e) => e.start > now && e.start < tomorrow).sort((a, b) => a.start - b.start)[0];
  let lesson;
  if (running) {
    const pct = Math.min(100, Math.floor(((now - running.start) / (running.end - running.start)) * 100));
    lesson = { pct, title: running.title, sub: `noch ${ttMins(running.end - now)} · bis ${ttClock(running.end)}` };
  } else if (next) {
    lesson = { pct: null, title: 'Gerade keine Vorlesung', sub: `Nächste: ${next.title} um ${ttClock(next.start)}` };
  } else {
    lesson = { pct: null, title: 'Gerade keine Vorlesung', sub: events.some((e) => e.start >= today && e.start < tomorrow) ? 'Für heute geschafft' : 'Heute keine Vorlesungen' };
  }

  const day = ttDone(events, today, tomorrow, now);
  const wk = ttDone(events, week, ttAddDays(week, 7), now);
  const item = (label, pct, title, sub) => `<div class="ttp-item">
      <div class="ttp-top"><span class="ttp-label">${label}</span><b class="ttp-pct">${pct == null ? '–' : pct + '<small> %</small>'}</b></div>
      <div class="progress"><i style="width:${pct || 0}%"></i></div>
      <div class="ttp-title" title="${esc(title)}">${esc(title)}</div><div class="ttp-sub">${esc(sub)}</div>
    </div>`;
  return item('Stunde', lesson.pct, lesson.title, lesson.sub)
    + item('Tag', day.pct, day.total ? `${ttMins(day.done)} von ${ttMins(day.total)}` : 'Heute frei', day.total ? (day.done >= day.total ? 'Alles geschafft' : `noch ${ttMins(day.total - day.done)}`) : 'Keine Vorlesungen heute')
    + item('Woche', wk.pct, wk.total ? `${ttMins(wk.done)} von ${ttMins(wk.total)}` : 'Diese Woche frei', wk.total ? (wk.done >= wk.total ? 'Alles geschafft' : `noch ${ttMins(wk.total - wk.done)}`) : 'Keine Vorlesungen diese Woche');
}

function updateTtProgress() {
  const el = $('#tt-progress');
  if (el) el.innerHTML = ttProgressHtml();
}

function placeNowLine() {
  const line = $('#tt-now');
  if (!line) return;
  const top = (ttHourOf(Date.now()) - Number(line.dataset.from)) * TT_HOUR_PX;
  line.style.top = `${top}px`;
  line.hidden = top < 0 || top > Number(line.dataset.max);
}

function renderTimetable() {
  const t = S.tt;
  if (!t.list || t.loadedKey !== `${t.active}|${t.week}`) loadTimetable();
  const plan = t.list && t.list.find((x) => x.id === t.active);
  const range = `${new Date(t.week).toLocaleDateString('de-DE', { day: 'numeric', month: 'long' })} – ${new Date(ttAddDays(t.week, 6)).toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' })}`;
  const isThisWeek = t.week === ttMonday(new Date());

  const head = `<div class="page-head"><div><h1>Stundenplan</h1><p>${plan ? `${esc(plan.name)} · Stand ${relTime(plan.fetchedAt)}${plan.error ? ` · <span style="color:var(--warning)">${esc(plan.error)}</span>` : ''}` : 'Füge deinen Stundenplan-Link hinzu'}</p></div>
    <div class="tt-nav">
      ${t.list && t.list.length > 1 ? `<div class="segmented">${t.list.map((x) => `<button class="${x.id === t.active ? 'on' : ''}" data-action="tt-select" data-id="${esc(x.id)}">${esc(x.name)}</button>`).join('')}</div>` : ''}
      <button class="btn sm ${isThisWeek ? '' : 'primary'}" data-action="tt-today">Heute</button>
      <div class="segmented"><button data-action="tt-week" data-d="-1" title="Vorige Woche">${icon('chevleft', 'sm')}</button><button data-action="tt-week" data-d="1" title="Nächste Woche">${icon('chevright', 'sm')}</button></div>
      <button class="icon-btn" data-action="tt-refresh" title="Jetzt aktualisieren">${icon('refresh', t.busy ? 'spin' : '')}</button>
    </div></div>`;

  let grid;
  if (!t.list) grid = `<div class="card"><div class="empty">${icon('refresh', 'spin')}<div>Lade Stundenplan…</div></div></div>`;
  else if (!plan) grid = `<div class="card"><div class="empty">${icon('calendar')}<div>Noch kein Stundenplan eingetragen. Füge unten einen Rapla- oder iCal-Link hinzu.</div></div></div>`;
  else grid = `<div class="card tt-progress" id="tt-progress">${ttProgressHtml()}</div>${ttWeekGrid(t.events, range)}`;

  return `<div class="page wide">${head}${grid}${ttManageCard()}</div>`;
}

function ttWeekGrid(events, range) {
  const t = S.tt;
  const timed = events.filter((e) => !e.allDay);
  const allDay = events.filter((e) => e.allDay);
  const weekend = timed.some((e) => e.start >= ttAddDays(t.week, 5));
  const nDays = weekend ? 7 : 5;
  const from = Math.max(6, Math.min(8, ...timed.map((e) => Math.floor(ttHourOf(e.start)))));
  const to = Math.min(24, Math.max(18, ...timed.map((e) => Math.ceil(ttHourOf(e.end) || 24))));
  const height = (to - from) * TT_HOUR_PX;
  const today = new Date().setHours(0, 0, 0, 0);

  const cols = [];
  for (let i = 0; i < nDays; i++) {
    const day = ttAddDays(t.week, i);
    const next = ttAddDays(day, 1);
    const dayEvents = timed.filter((e) => e.start >= day && e.start < next);
    const holidays = allDay.filter((e) => e.start < next && e.end > day);
    const blocks = ttLayoutDay(dayEvents).map(({ e, lane, lanes }) => {
      const top = (ttHourOf(e.start) - from) * TT_HOUR_PX;
      const h = Math.max(22, ((e.end - e.start) / 3600000) * TT_HOUR_PX - 3);
      const room = e.location.split(/\s+/)[0] || '';
      const tip = [e.title, `${ttClock(e.start)}–${ttClock(e.end)}`, e.location, e.persons.join(', ')].filter(Boolean).join('\n');
      return `<button class="tt-ev c${ttColor(e.title)}${e.end < Date.now() ? ' past' : ''}${h < 44 ? ' short' : ''}" style="top:${top}px;height:${h}px;left:calc(${(lane / lanes) * 100}% + 2px);width:calc(${100 / lanes}% - 4px)" data-action="tt-event" data-i="${t.events.indexOf(e)}" title="${esc(tip)}">
        <b>${esc(e.title)}</b><span class="tt-meta">${ttClock(e.start)}–${ttClock(e.end)}${room ? ` · ${esc(room)}` : ''}</span>${h > 80 && e.persons.length ? `<span class="tt-who">${esc(e.persons.join(', '))}</span>` : ''}
      </button>`;
    }).join('');
    const isToday = day === today;
    cols.push(`<div class="tt-col${isToday ? ' today' : ''}">
      <div class="tt-day"><span>${TT_DAYS[i].slice(0, 2)}</span><b>${new Date(day).getDate()}.</b>${holidays.map((e) => `<em class="tt-holiday" title="${esc(e.title)}">${esc(e.title)}</em>`).join('')}</div>
      <div class="tt-body" style="height:${height}px">${blocks}${isToday ? `<div class="tt-now" id="tt-now" data-from="${from}" data-max="${height}" hidden></div>` : ''}</div>
    </div>`);
  }
  const hours = [];
  for (let h = from; h < to; h++) hours.push(`<div class="tt-hour" style="top:${(h - from) * TT_HOUR_PX}px">${String(h).padStart(2, '0')}:00</div>`);
  setTimeout(placeNowLine);
  return `<div class="card tt-card">
    <div class="tt-range"><b>KW ${ttIsoWeek(t.week)}</b><span>${range}</span><span class="muted">${timed.length} ${timed.length === 1 ? 'Termin' : 'Termine'}</span></div>
    <div class="tt-grid" style="--days:${nDays}">
      <div class="tt-gutter"><div class="tt-day"></div><div class="tt-body" style="height:${height}px">${hours.join('')}</div></div>
      ${cols.join('')}
    </div>
  </div>`;
}

function ttManageCard() {
  const t = S.tt;
  const rows = (t.list || []).map((x) => `<div class="setting-row">
      <div class="txt" style="min-width:0"><b>${esc(x.name)}${x.id === t.active ? ' <span class="chip info">angezeigt</span>' : ''}</b><small class="tt-url" title="${esc(x.url)}">${esc(x.url)}</small><small>${x.fetchedAt ? `${x.count} Termine · aktualisiert ${relTime(x.fetchedAt)}` : 'noch nicht geladen'}${x.error ? ` · <span style="color:var(--warning)">${esc(x.error)}</span>` : ''}</small></div>
      <div class="ctl">${x.id !== t.active ? `<button class="btn sm" data-action="tt-select" data-id="${esc(x.id)}">Anzeigen</button>` : ''}<button class="btn sm ghost danger" data-action="tt-remove" data-id="${esc(x.id)}">Entfernen</button></div>
    </div>`).join('');
  return `<div class="card" style="margin-top:20px">
    <div class="card-head"><h2>${icon('calendar')} Stundenpläne verwalten</h2></div>
    <div class="card-body">
      ${rows || '<p class="muted small" style="margin:0 0 8px">Noch keine Stundenpläne eingetragen.</p>'}
      <form class="tt-form" data-submit="tt-add">
        <input class="input" id="tt-name" data-input="tt-form" data-key="name" placeholder="Name, z. B. TSA25" value="${esc(t.form.name)}" />
        <input class="input" id="tt-url" data-input="tt-form" data-key="url" placeholder="Rapla-Link oder iCal-Adresse (https://… oder webcal://…)" value="${esc(t.form.url)}" />
        <button type="button" class="btn" data-action="tt-template" title="Rapla-Plan TSA25 der DHBW Ravensburg einsetzen">Vorlage TSA25</button>
        <button class="btn primary" ${t.busy ? 'disabled' : ''}>${icon('plus', 'sm')} Hinzufügen</button>
      </form>
      <p class="muted small" style="margin:10px 0 0">Funktioniert mit Rapla-Links der DHBW (Ansicht oder Export) und mit jedem iCal-Kalender. Der Plan wird lokal gespeichert, ist offline verfügbar und wird alle zwei Stunden aktualisiert.</p>
    </div>
  </div>`;
}

function renderEventsPage() {
  const evs = S.data.events;
  return `<div class="page">
    <div class="page-head"><div><h1>Termine</h1><p>Anstehende Abgaben und Aktivitäten aus allen Kursen</p></div><button class="btn claude" data-action="ask" data-q="Plane meine nächsten zwei Wochen anhand meiner anstehenden Abgaben und Termine. Was sollte ich wann erledigen?">${icon('sparkles', 'sm')} Wochenplan mit KI</button></div>
    <div class="card"><div class="card-body" style="padding-top:16px">${timelineHtml(evs)}</div></div>
  </div>`;
}

// Einstellungen
function renderSettings() {
  const s = S.state.settings;
  const tab = S.ui.settingsTab;
  const sw = (key, on) => `<label class="switch"><input type="checkbox" data-change="setting-bool" data-key="${key}" ${on ? 'checked' : ''} /><span></span></label>`;
  const row = (title, sub, ctl) => `<div class="setting-row"><div class="txt"><b>${title}</b><small>${sub}</small></div><div class="ctl">${ctl}</div></div>`;
  const tabs = [['sync', 'Synchronisation', 'refresh'], ['ai', 'KI-Assistent', 'sparkles'], ['look', 'Darstellung', 'moon'], ['update', 'Updates', 'download'], ['account', 'Konto', 'user']];
  let body = '';
  if (tab === 'sync') {
    body = `<div class="card"><div class="card-head"><h2>Synchronisation & Downloads</h2></div><div class="card-body">
      ${row('Download-Ordner', `<span class="path-box" title="${esc(s.downloadDir)}">${esc(s.downloadDir)}</span>`, `<button class="btn sm" data-action="pick-folder">Ändern</button><button class="btn sm ghost" data-action="open-folder">${icon('folder', 'sm')}</button>`)}
      ${row('Sync-Intervall', 'Wie oft im Hintergrund nach neuen Inhalten gesucht wird', `<select class="select" style="width:150px" data-change="setting-num" data-key="syncIntervalMin">${[10, 15, 30, 60, 120, 240].map((v) => `<option value="${v}" ${s.syncIntervalMin == v ? 'selected' : ''}>alle ${v < 60 ? v + ' Min.' : v / 60 + ' Std.'}</option>`).join('')}</select>`)}
      ${row('Dateien automatisch herunterladen', 'Alle Kursdateien werden lokal gespeichert und sind offline verfügbar', sw('autoDownload', s.autoDownload))}
      ${row('Maximale Dateigröße', 'Größere Dateien werden erst beim Öffnen geladen', `<select class="select" style="width:150px" data-change="setting-num" data-key="maxFileSizeMB">${[[25, '25 MB'], [50, '50 MB'], [100, '100 MB'], [200, '200 MB'], [500, '500 MB'], [100000, 'unbegrenzt']].map(([v, l]) => `<option value="${v}" ${s.maxFileSizeMB == v ? 'selected' : ''}>${l}</option>`).join('')}</select>`)}
      ${row('Benachrichtigungen', 'Windows-Hinweise bei neuen Dateien und bald fälligen Abgaben', sw('notifications', s.notifications))}
      ${row('Im Hintergrund weiterlaufen', 'Beim Schließen des Fensters in den Infobereich minimieren', sw('runInBackground', s.runInBackground))}
      ${row('Mit Windows starten', 'Startet unsichtbar im Infobereich und synchronisiert automatisch', sw('startWithWindows', s.startWithWindows))}
    </div></div>`;
  } else if (tab === 'ai') {
    const models = CLAUDE_MODELS;
    const g = S.chatgpt || {};
    const p = prov();
    const pcard = (v, title, sub, ic, cls) => `<button class="prov-card ${p === v ? 'on' : ''}" data-action="set-provider" data-v="${v}"><div class="cp-logo ${cls}">${icon(ic)}</div><div><b>${title}</b><small>${sub}</small></div>${p === v ? `<span class="chip ok">${icon('check', 'sm')} Aktiv</span>` : ''}</button>`;
    body = `<div class="stack">
      <div class="card"><div class="card-head"><h2>${icon('sparkles')} KI-Assistent</h2></div><div class="card-body">
        <p class="muted small" style="margin:0 0 12px">Der Assistent durchsucht deine synchronisierten Unterlagen, findet die passenden Stellen und erklärt sie. Wähle, womit er arbeitet:</p>
        <div class="prov-grid">
          ${pcard('chatgpt', 'ChatGPT', 'Mit deinem Plus-/Pro-Plan – ohne API-Key', 'message', 'p-chatgpt')}
          ${pcard('claude', 'Claude', 'Mit eigenem Anthropic-API-Key', 'sparkles', 'p-claude')}
        </div>
        ${row('Antwortstil', 'Schnell antwortet zügig, Gründlich denkt länger nach (gilt für beide Anbieter)', `<div class="segmented">${EFFORTS.map(([v, l]) => `<button class="${(s.aiEffort || 'balanced') === v ? 'on' : ''}" data-action="set-effort" data-v="${v}">${l}</button>`).join('')}</div>`)}
        ${row('Zugriff auf Noten', 'Erlaubt der KI, deine Bewertungen und das Feedback dazu zu lesen. Diese Daten werden dann an den gewählten Anbieter übertragen.', sw('aiGrades', s.aiGrades))}
      </div></div>
      <div class="card"><div class="card-head"><h2>${icon('message')} ChatGPT</h2></div><div class="card-body">
        ${g.signedIn ? `
          ${row('Verbunden', `${esc(g.email || g.name || 'ChatGPT-Konto')} ${g.planUsage ? '<span class="chip ok">Plan-Nutzung aktiv</span>' : '<span class="chip warn">Plan-Nutzung nicht freigegeben</span>'}<br>Du bleibst angemeldet – die App erneuert die Anmeldung automatisch.`, `<button class="btn sm" data-action="external" data-url="${MANAGE_USAGE_URL}">Nutzung verwalten</button><button class="btn sm ghost" data-action="chatgpt-logout">Abmelden</button>`)}
          ${row('Modell', 'Modelle, die dein ChatGPT-Plan für Apps freigibt', S.gptModels && S.gptModels.length ? `<select class="select" style="width:260px" data-change="setting-str" data-key="chatgptModel">${S.gptModels.map((m) => `<option value="${esc(m.id)}" ${gptSelectedModel() === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>` : `<button class="btn sm" data-action="chatgpt-models">${icon('refresh', 'sm')} Modelle laden</button>`)}
          ${row('Anderes Konto', 'Mit einem anderen ChatGPT-Konto anmelden', '<button class="btn sm ghost" data-action="chatgpt-switch">Konto wechseln</button>')}
          ${row('Protokoll', 'Technisches Protokoll der ChatGPT-Anmeldung (ohne Passwörter/Tokens)', '<button class="btn sm ghost" data-action="chatgpt-log">Protokoll öffnen</button>')}
        ` : `
          ${row('Nicht verbunden', 'Für ChatGPT Plus und Pro. Anfragen zählen zu deinem ChatGPT-Plan; ein wöchentliches Limit für diese App legst du in den ChatGPT-Einstellungen fest.', S.gptLogin ? '<button class="btn sm" data-action="chatgpt-cancel">Abbrechen</button>' : '<button class="btn sm chatgpt" data-action="chatgpt-login">Continue with ChatGPT</button>')}
          ${row('Protokoll', 'Bei Anmeldeproblemen: technisches Protokoll (ohne Passwörter/Tokens)', '<button class="btn sm ghost" data-action="chatgpt-log">Protokoll öffnen</button>')}
        `}
      </div></div>
      <div class="card"><div class="card-head"><h2>${icon('sparkles')} Claude</h2></div><div class="card-body">
        <form data-submit="claude-key">
          ${row('API-Key', S.state.hasClaudeKey ? '<span class="chip ok">Hinterlegt</span> Wird verschlüsselt gespeichert (Windows DPAPI)' : 'Erstelle einen Key unter console.anthropic.com → API Keys', `<input id="claude-key-input" type="password" class="input" style="width:240px" placeholder="sk-ant-…" /><button class="btn sm primary">Speichern</button>${S.state.hasClaudeKey ? '<button type="button" class="btn sm ghost danger" data-action="remove-key">Entfernen</button>' : ''}`)}
        </form>
        ${row('Modell', 'Wird für alle neuen Nachrichten verwendet', `<select class="select" style="width:300px" data-change="setting-str" data-key="claudeModel">${models.map(([v, l]) => `<option value="${v}" ${s.claudeModel === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`)}
      </div></div>
      <p class="muted small" style="margin:0">Die KI greift nur über die lokale Kopie auf deine Kursdaten zu. Gelesene Dokumentstellen und Kursinhalte werden für die Antwort an den gewählten Anbieter übertragen, Namen von Forenautoren nie. Kursunterlagen sind urheberrechtlich geschützt, und die Moodle-Nutzungsbedingungen deiner Hochschule können die Weitergabe an Dritte einschränken. Kläre im Zweifel mit deiner Hochschule, ob du die KI-Funktion nutzen darfst.</p>
    </div>`;
  } else if (tab === 'update') {
    const u = S.update || {};
    body = `<div class="card"><div class="card-head"><h2>${icon('download')} Updates</h2></div><div class="card-body">
      ${row('Installierte Version', 'Chadoodle', `<span class="chip info">${esc(S.state.version)}</span>`)}
      ${row('Status', esc(updateText(u)) + (u.state === 'error' && u.message ? `<br><span class="small muted">${esc(u.message)}</span>` : ''),
        u.state === 'ready' ? '<button class="btn sm primary" data-action="update-install">Neu starten & installieren</button>'
        : `<button class="btn sm" data-action="update-check" ${['dev', 'checking', 'downloading'].includes(u.state) ? 'disabled' : ''}>${icon('refresh', 'sm' + (u.state === 'checking' ? ' spin' : ''))} Nach Updates suchen</button>`)}
      ${u.state === 'downloading' ? `<div class="progress" style="margin:4px 0 12px"><i style="width:${u.progress || 0}%"></i></div>` : ''}
      <p class="muted small" style="margin:12px 0 0">Neue Versionen werden automatisch im Hintergrund geladen und still installiert, sobald die App gerade nicht benutzt wird. Deine Kurse, Dateien und Einstellungen bleiben dabei erhalten.</p>
    </div></div>`;
  } else if (tab === 'look') {
    body = `<div class="card"><div class="card-head"><h2>Darstellung</h2></div><div class="card-body">
      ${row('Farbschema', 'Hell, dunkel oder wie Windows', `<div class="segmented">${[['system', 'System'], ['light', 'Hell'], ['dark', 'Dunkel']].map(([v, l]) => `<button class="${s.theme === v ? 'on' : ''}" data-action="set-theme" data-v="${v}">${l}</button>`).join('')}</div>`)}
    </div></div>`;
  } else {
    const site = S.data.site || {};
    body = `<div class="card"><div class="card-head"><h2>Konto</h2></div><div class="card-body">
      <div class="dd-user" style="padding:6px 0 14px"><div class="avatar" style="width:52px;height:52px">${site.avatar ? `<img src="${esc(site.avatar)}" alt="" />` : initials(site.fullname)}</div><div><b style="font-size:16px">${esc(site.fullname)}</b><div class="muted small">${esc(site.sitename)} · ${esc(site.url)}</div><div class="muted small">Moodle ${esc(site.release || '')}</div></div></div>
      ${row('Abmelden', 'Entfernt das Zugriffstoken; lokale Dateien bleiben auf Wunsch erhalten', '<button class="btn sm danger" data-action="logout">Abmelden</button>')}
      ${row('Version', 'Chadoodle', `<span class="muted">${esc(S.state.version)}</span>`)}
    </div></div>`;
  }
  return `<div class="page">
    <div class="page-head"><div><h1>Einstellungen</h1></div></div>
    <div class="settings-grid">
      <nav class="settings-nav">${tabs.map(([v, l, ic]) => `<a href="#" class="${tab === v ? 'active' : ''}" data-action="settings-tab" data-v="${v}">${icon(ic, 'sm')} ${l}</a>`).join('')}</nav>
      <div>${body}</div>
    </div>
  </div>`;
}

// ---------- Dokumente: Viewer & Volltextsuche ----------
const isPdf = (f) => /\.pdf$/i.test(f.filename) || f.mimetype === 'application/pdf';
const canRead = (f) => /\.(pdf|docx|pptx|xlsx|odt|odp|txt|md|csv|tex|c|h|cpp|py|java|m|vhd|vhdl|js|ts|json|xml|html?)$/i.test(f.filename);
const V = { ctl: null, mountedFor: null, page: 1, total: 0, sel: null, hits: null, hitIdx: -1, textPages: null, loading: false, error: null };
let pdfModule = null;

function hlHtml(text, terms) {
  let html = esc(text);
  for (const t of terms || []) {
    if (!t) continue;
    const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/a/g, '[aä]').replace(/o/g, '[oö]').replace(/u/g, '[uü]').replace(/ss/g, '(?:ss|ß)'), 'gi');
    html = html.replace(re, (m) => `<mark>${m}</mark>`);
  }
  return html;
}

function renderViewer() {
  const f = S.data.files[S.route.params.fileId];
  if (!f) return `<div class="page"><div class="card empty">Dokument nicht gefunden</div></div>`;
  const k = courseById(f.courseId);
  const pdf = isPdf(f);
  const q = S.route.params.q || '';
  return `<div class="viewer">
    <div class="viewer-bar">
      <button class="icon-btn" data-action="viewer-back" title="Zurück">${icon('chevleft')}</button>
      <div class="vb-title"><b title="${esc(f.filename)}">${esc(f.filename)}</b><small>${esc(k ? k.shortname || k.fullname : '')} · ${esc(f.moduleName)}</small></div>
      <div class="vb-group">
        <button class="icon-btn sm" data-action="viewer-page" data-d="-1" title="Vorherige Seite">${icon('chevleft', 'sm')}</button>
        <span class="vb-page"><input id="viewer-page" class="input" value="${V.page}" data-input="viewer-page" /> / <span id="viewer-total">${V.total || '…'}</span></span>
        <button class="icon-btn sm" data-action="viewer-page" data-d="1" title="Nächste Seite">${icon('chevright', 'sm')}</button>
      </div>
      ${pdf ? `<div class="vb-group">
        <button class="icon-btn sm" data-action="viewer-zoom" data-z="out" title="Verkleinern">${icon('minus', 'sm')}</button>
        <button class="btn sm ghost" data-action="viewer-zoom" data-z="fit" id="viewer-zoom-label" title="An Breite anpassen">Breite</button>
        <button class="icon-btn sm" data-action="viewer-zoom" data-z="in" title="Vergrößern">${icon('plus', 'sm')}</button>
      </div>` : ''}
      <form class="vb-search" data-submit="viewer-search">
        <div class="input-icon">${icon('search', 'sm')}<input id="viewer-q" class="input" placeholder="Im Dokument suchen…" value="${esc(q)}" /></div>
        <span class="muted small" id="viewer-hits"></span>
      </form>
      <div class="vb-group">
        <button class="btn sm claude" data-action="viewer-ask" data-mode="page" title="Aktuelle Seite erklären lassen">${icon('sparkles', 'sm')} Seite erklären</button>
        <button class="icon-btn sm" data-action="viewer-ask" data-mode="summary" title="Dokument zusammenfassen">${icon('list', 'sm')}</button>
        <button class="icon-btn sm" data-action="show-file" data-file="${f.id}" title="Im Ordner zeigen">${icon('folder', 'sm')}</button>
        <button class="icon-btn sm" data-action="open-file-external" data-file="${f.id}" title="Mit Standard-App öffnen">${icon('external', 'sm')}</button>
      </div>
    </div>
    <div class="viewer-body">
      <div class="viewer-scroll" id="viewer-scroll">${V.error ? `<div class="card empty" style="margin:40px auto;max-width:480px">${icon('alert')}<div>${esc(V.error)}</div></div>` : `<div class="empty">${icon('refresh', 'spin')}<div>Lade Dokument…</div></div>`}</div>
      <div class="viewer-hitlist" id="viewer-hitlist" hidden></div>
    </div>
    <div class="sel-bubble" id="sel-bubble" hidden>
      <button class="btn sm claude" data-action="sel-ask" data-mode="explain">${icon('sparkles', 'sm')} Erklären</button>
      <button class="btn sm" data-action="sel-ask" data-mode="ask">Frage dazu…</button>
      <button class="btn sm ghost" data-action="sel-ask" data-mode="search">${icon('search', 'sm')} In allen Dokumenten</button>
    </div>
  </div>`;
}

async function mountViewer() {
  const id = S.route.params.fileId;
  const f = S.data.files[id];
  const host = $('#viewer-scroll');
  if (!f || !host) return;
  V.mountedFor = id;
  V.error = null;
  try {
    if (isPdf(f)) {
      pdfModule = pdfModule || (await import('./viewer.js'));
      const data = await api.fileData(id);
      if (V.mountedFor !== id) return;
      host.innerHTML = '';
      const terms = S.route.params.q ? S.route.params.q.split(/\s+/) : [];
      V.ctl = await pdfModule.openPdf(host, {
        data, page: S.route.params.page || 1, zoom: 'fit', terms,
        onPage: (n, total) => { V.page = n; V.total = total; updateViewerBar(); },
        onSelection: (sel) => showSelBubble(sel),
        onZoom: () => updateViewerBar(),
      });
      V.total = V.ctl.numPages;
      V.page = S.route.params.page || 1;
    } else {
      const r = await api.docPages(id, 1, 2000);
      if (V.mountedFor !== id) return;
      V.textPages = r.pages;
      V.total = r.total;
      V.page = S.route.params.page || 1;
      renderTextPages();
      if (V.page > 1) goToPage(V.page);
      V.textZoom = 1;
      host.onwheel = (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        V.textZoom = Math.max(0.6, Math.min(2.5, V.textZoom * Math.exp(-e.deltaY * 0.0018)));
        host.style.setProperty('--tp-zoom', V.textZoom);
        updateViewerBar();
      };
      host.onscroll = () => {
        const mid = host.getBoundingClientRect().top + host.clientHeight / 3;
        const el = [...host.querySelectorAll('.text-page')].find((p) => { const r = p.getBoundingClientRect(); return r.top <= mid && r.bottom >= mid; });
        if (el && Number(el.dataset.page) !== V.page) { V.page = Number(el.dataset.page); updateViewerBar(); }
      };
      host.onmouseup = () => setTimeout(() => {
        const s = window.getSelection();
        const text = s ? s.toString().trim() : '';
        if (!text) return showSelBubble(null);
        const pageEl = s.anchorNode.parentElement && s.anchorNode.parentElement.closest('.text-page');
        showSelBubble({ text, rect: s.getRangeAt(0).getBoundingClientRect(), page: pageEl ? Number(pageEl.dataset.page) : V.page });
      }, 10);
    }
    updateViewerBar();
    renderClaudeContext();
    if (S.route.params.q) viewerSearch(S.route.params.q, false);
  } catch (e) {
    V.error = 'Dokument konnte nicht geöffnet werden: ' + cleanErr(e);
    host.innerHTML = `<div class="card empty" style="margin:40px auto;max-width:480px">${icon('alert')}<div>${esc(V.error)}</div><button class="btn" style="margin-top:12px" data-action="open-file-external" data-file="${id}">Mit Standard-App öffnen</button></div>`;
  }
}

function renderTextPages(terms = []) {
  const host = $('#viewer-scroll');
  if (!host || !V.textPages) return;
  const f = S.data.files[V.mountedFor];
  const label = /\.(pptx|odp)$/i.test(f.filename) ? 'Folie' : /\.xlsx$/i.test(f.filename) ? 'Tabelle' : 'Abschnitt';
  host.innerHTML = `<div class="text-pages">${V.textPages.map((p) => `<div class="text-page card" data-page="${p.n}"><div class="tp-head">${label} ${p.n}</div><div class="tp-body">${hlHtml(p.text, terms) || '<span class="muted">(kein Text)</span>'}</div></div>`).join('')}</div>`;
}

function unmountViewer() {
  if (V.ctl) V.ctl.destroy();
  Object.assign(V, { ctl: null, mountedFor: null, page: 1, total: 0, sel: null, hits: null, hitIdx: -1, textPages: null, error: null });
}

function updateViewerBar() {
  const inp = $('#viewer-page');
  if (inp && document.activeElement !== inp) inp.value = V.page;
  if ($('#viewer-total')) $('#viewer-total').textContent = V.total || '…';
  if ($('#viewer-zoom-label') && V.ctl) $('#viewer-zoom-label').textContent = Math.round(V.ctl.scale * 100) + ' %';
  if ($('#viewer-zoom-label') && !V.ctl && V.textZoom) $('#viewer-zoom-label').textContent = Math.round(V.textZoom * 100) + ' %';
  const chip = $('#ctx-page');
  if (chip) chip.textContent = `S. ${V.page}`;
}

function goToPage(n) {
  n = Math.max(1, Math.min(V.total || 1, n));
  if (V.ctl) V.ctl.goTo(n, true);
  else {
    const el = document.querySelector(`.text-page[data-page="${n}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  V.page = n;
  updateViewerBar();
}

function showSelBubble(sel) {
  const b = $('#sel-bubble');
  if (!b) return;
  V.sel = sel;
  if (!sel || sel.text.length < 2) { b.hidden = true; return; }
  const host = $('.viewer').getBoundingClientRect();
  b.hidden = false;
  b.style.left = `${Math.max(8, Math.min(host.width - 380, sel.rect.left - host.left))}px`;
  b.style.top = `${Math.max(56, sel.rect.bottom - host.top + 8)}px`;
}

async function viewerSearch(q, jump = true) {
  const id = V.mountedFor;
  const list = $('#viewer-hitlist');
  if (!q.trim()) {
    V.hits = null;
    if (list) list.hidden = true;
    if ($('#viewer-hits')) $('#viewer-hits').textContent = '';
    V.ctl ? V.ctl.highlight([]) : renderTextPages();
    return;
  }
  const r = await api.docSearch(q, { fileId: id, limit: 200, perFile: 200 });
  V.hits = r.hits.sort((a, b) => a.page - b.page);
  V.hitIdx = -1;
  if (V.ctl) V.ctl.highlight(r.terms); else renderTextPages(r.terms);
  if ($('#viewer-hits')) $('#viewer-hits').textContent = r.hits.length ? `${r.hits.length} Seite${r.hits.length > 1 ? 'n' : ''}` : 'keine Treffer';
  if (list) {
    list.hidden = !r.hits.length;
    list.innerHTML = `<div class="hl-head"><b>Treffer</b><button class="icon-btn sm" data-action="viewer-hits-close">${icon('x', 'sm')}</button></div>` +
      V.hits.map((h, i) => `<div class="hl-item" data-action="viewer-hit" data-i="${i}"><span class="chip info">S. ${h.page}</span><div class="small">${hlHtml(h.snippet, r.terms)}</div></div>`).join('');
  }
  if (jump && V.hits.length) { V.hitIdx = 0; goToPage(V.hits[0].page); }
}

async function openDoc(fileId, page = 1, q = '') {
  const f = S.data.files[fileId];
  if (!f) return;
  if (!canRead(f)) return openFile(fileId, true);
  if (S.route.name === 'viewer' && V.mountedFor === fileId) {
    if (q && q !== S.route.params.q) { S.route.params.q = q; $('#viewer-q').value = q; viewerSearch(q, false); }
    return goToPage(page);
  }
  if (!f.downloaded) toast(`Lade ${f.filename}…`);
  go('viewer', { fileId, page, q });
}

// Globale Dokumentsuche
function renderSearch() {
  const q = S.route.params.q || '';
  const r = S.search && S.search.q === q ? S.search : null;
  const st = S.index;
  let body = '';
  if (!q) body = `<div class="card empty">${icon('search')}<div>Suche im Inhalt aller Skripte, Folien und Dokumente – seitengenau.</div></div>`;
  else if (!r) body = `<div class="empty">${icon('refresh', 'spin')}</div>`;
  else if (!r.hits.length) body = `<div class="card empty">${icon('search')}<div>Keine Fundstellen für „${esc(q)}“.</div></div>`;
  else {
    const groups = [];
    for (const h of r.hits) {
      let g = groups.find((x) => x.fileId === h.fileId);
      if (!g) groups.push((g = { fileId: h.fileId, hits: [] }));
      g.hits.push(h);
    }
    body = groups.map((g) => {
      const f = S.data.files[g.fileId];
      if (!f) return '';
      const k = courseById(f.courseId);
      return `<div class="card result">
        <div class="result-head" data-action="open-doc" data-file="${f.id}" data-page="${g.hits[0].page}" data-q="${esc(q)}">
          ${icon(isPdf(f) ? 'filetext' : 'file')}
          <div class="grow"><b>${esc(f.filename)}</b><small>${esc(k ? k.shortname || k.fullname : '')} · ${esc(f.section.replace(/^\d+ /, ''))}</small></div>
          <button class="icon-btn sm claude-mini" data-action="ask-file" data-file="${f.id}" title="Mit KI besprechen">${icon('sparkles', 'sm')}</button>
        </div>
        ${g.hits.map((h) => `<div class="result-hit" data-action="open-doc" data-file="${f.id}" data-page="${h.page}" data-q="${esc(q)}"><span class="chip info">S. ${h.page}</span><div>${hlHtml(h.snippet, r.terms)}</div></div>`).join('')}
      </div>`;
    }).join('');
  }
  return `<div class="page">
    <div class="page-head"><div><h1>Dokumente durchsuchen</h1><p>${st ? `${st.indexed} von ${st.total} Dokumenten indexiert${st.running ? ' · indexiere…' : ''}` : ''}</p></div>
      ${q ? `<button class="btn claude" data-action="ask" data-q="${esc(`Suche in meinen Unterlagen nach „${q}“ und erkläre mir, was dort dazu steht – mit Fundstellen.`)}">${icon('sparkles', 'sm')} KI fragen</button>` : ''}</div>
    <form class="toolbar" data-submit="doc-search">
      <div class="input-icon" style="max-width:none">${icon('search')}<input id="search-q" class="input" placeholder="z. B. Resonanzfrequenz, &quot;komplexe Impedanz&quot;, Eigenwerte" value="${esc(q)}" /></div>
      <button class="btn primary">Suchen</button>
    </form>
    ${r && r.hits.length ? `<p class="muted small" style="margin:-6px 0 14px">${r.totalPages} Seiten in ${r.totalFiles} Dokumenten</p>` : ''}
    <div class="stack" style="gap:14px">${body}</div>
  </div>`;
}

async function runSearch(q) {
  S.search = null;
  go('search', { q });
  if (!q) return;
  const r = await api.docSearch(q, { limit: 60, perFile: 5 });
  S.search = { q, ...r };
  if (S.route.name === 'search' && S.route.params.q === q) renderMain();
}

// ---------- KI-Panel (Claude oder ChatGPT) ----------
const CLAUDE_MODELS = [
  ['claude-opus-5', 'Claude Opus 5 – empfohlen'],
  ['claude-sonnet-5', 'Claude Sonnet 5 – schneller & günstiger'],
  ['claude-haiku-4-5', 'Claude Haiku 4.5 – am günstigsten'],
  ['claude-fable-5-1', 'Claude Fable 5.1 – leistungsstärkstes Modell'],
];
const EFFORTS = [['fast', 'Schnell'], ['balanced', 'Ausgewogen'], ['thorough', 'Gründlich']];
// Gleiche Regel wie im Hauptprozess: standardmäßig kein „Pro“-Modell (die denken oft minutenlang)
function gptDefaultModel(list) {
  const normal = (list || []).find((m) => !/(^|[-_ ])pro\b/i.test(m.id + ' ' + m.name));
  return (normal || (list || [])[0] || {}).id || '';
}
function gptSelectedModel() {
  const list = S.gptModels || [];
  const wanted = S.state.settings.chatgptModel;
  return wanted && list.some((m) => m.id === wanted) ? wanted : gptDefaultModel(list);
}

function modelBar() {
  const s = S.state.settings;
  const gpt = prov() === 'chatgpt';
  let select;
  if (gpt) {
    const list = S.gptModels || [];
    select = list.length
      ? `<select class="select" data-change="setting-str" data-key="chatgptModel" title="Modell">${list.map((m) => `<option value="${esc(m.id)}" ${gptSelectedModel() === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>`
      : `<button class="btn sm ghost" data-action="chatgpt-models">${icon('refresh', 'sm')} Modelle laden</button>`;
  } else {
    select = `<select class="select" data-change="setting-str" data-key="claudeModel" title="Modell">${CLAUDE_MODELS.map(([v, l]) => `<option value="${v}" ${s.claudeModel === v ? 'selected' : ''}>${l.split(' – ')[0]}</option>`).join('')}</select>`;
  }
  return `<div class="cp-model">${select}<div class="segmented sm-seg" title="Antwortstil">${EFFORTS.map(([v, l]) => `<button class="${(s.aiEffort || 'balanced') === v ? 'on' : ''}" data-action="set-effort" data-v="${v}">${l}</button>`).join('')}</div></div>`;
}

const PROVIDERS = {
  claude: { name: 'Claude', icon: 'sparkles', cls: 'p-claude' },
  chatgpt: { name: 'ChatGPT', icon: 'message', cls: 'p-chatgpt' },
};
const prov = () => (S.state && S.state.settings.aiProvider) || 'claude';
const MANAGE_USAGE_URL = 'https://chatgpt.com/settings/usage';

function providerReady(p = prov()) {
  if (p === 'chatgpt') return !!(S.chatgpt && S.chatgpt.signedIn && S.chatgpt.planUsage);
  return !!S.state.hasClaudeKey;
}

function providerModelLabel() {
  if (prov() === 'chatgpt') {
    const id = gptSelectedModel();
    const m = (S.gptModels || []).find((x) => x.id === id);
    return m ? m.name : 'ChatGPT-Plan';
  }
  return (S.state.settings.claudeModel || 'claude-opus-5').replace('claude-', '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).replace(/ (\d) (\d)$/, ' $1.$2');
}

function chatContext() {
  const ctx = {};
  if (!S.chat.ctxOn) return ctx;
  const cid = currentCourseId();
  if (cid) ctx.courseId = cid;
  if (S.route.name === 'module') ctx.moduleId = Number(S.route.params.cmid);
  if (S.chat.moduleId) ctx.moduleId = S.chat.moduleId;
  if (S.route.name === 'viewer' && V.mountedFor) {
    ctx.fileId = V.mountedFor;
    ctx.page = V.page;
    const f = S.data.files[V.mountedFor];
    if (f) ctx.courseId = f.courseId;
  }
  return ctx;
}

function renderClaude() {
  const el = $('#claude');
  if (!el) return;
  el.classList.toggle('closed', !S.ui.claudeOpen);
  const p = PROVIDERS[prov()];
  el.innerHTML = `
    <div class="cp-head">
      <div class="cp-logo ${p.cls}">${icon(p.icon)}</div>
      <div class="grow"><b>Lernassistent</b><small>${esc(p.name)} · ${esc(providerModelLabel())}</small></div>
      <div class="segmented sm-seg">${Object.entries(PROVIDERS).map(([k, v]) => `<button class="${prov() === k ? 'on' : ''}" data-action="set-provider" data-v="${k}" title="${v.name} verwenden">${v.name}</button>`).join('')}</div>
      <button class="icon-btn sm" data-action="chat-new" title="Neuer Chat">${icon('plus')}</button>
      <button class="icon-btn sm" data-action="toggle-claude" title="Schließen">${icon('x')}</button>
    </div>
    ${providerReady() ? modelBar() : ''}
    <div class="cp-body" id="cp-body"></div>
    <div class="cp-compose" id="cp-compose"></div>`;
  renderChatBody();
  renderCompose();
}

function setupCard() {
  if (prov() === 'chatgpt') {
    const st = S.chatgpt || {};
    if (S.gptLogin) {
      return `<div class="key-card"><h3>${icon('external', 'sm')} Anmeldung im Browser…</h3>
        <p>Melde dich im geöffneten Browserfenster bei ChatGPT an und erlaube die Nutzung deines Plans. Danach geht es hier automatisch weiter.</p>
        <button class="btn block" data-action="chatgpt-cancel">Abbrechen</button></div>`;
    }
    return `<div class="key-card"><h3>${icon('message', 'sm')} ChatGPT verbinden</h3>
      <p>Nutze deinen <b>ChatGPT Plus- oder Pro-Plan</b> – ohne API-Key. Anfragen in dieser App zählen zu deinem ChatGPT-Plan; in den ChatGPT-Einstellungen kannst du ein wöchentliches Limit für diese App festlegen.</p>
      ${st.signedIn && !st.planUsage ? '<p class="err" style="margin-bottom:12px">Die Plan-Nutzung wurde bei der Anmeldung nicht freigegeben. Melde dich erneut an und erlaube sie.</p>' : ''}
      <button class="btn chatgpt block" data-action="chatgpt-login">Continue with ChatGPT</button>
      <p class="small muted" style="margin:10px 0 0">Oder nutze <a href="#" data-action="set-provider" data-v="claude">Claude mit API-Key</a>.</p></div>`;
  }
  return `<div class="key-card"><h3>${icon('key', 'sm')} Claude einrichten</h3>
    <p>Hinterlege deinen Anthropic-API-Key, um mit Claude über deine Kursmaterialien zu sprechen. Den Key erstellst du unter console.anthropic.com.</p>
    <form data-submit="claude-key"><input id="claude-key-input" type="password" class="input" placeholder="sk-ant-…" style="margin-bottom:10px" /><button class="btn claude block">Speichern</button></form>
    <p class="small muted" style="margin:10px 0 0">Oder nutze <a href="#" data-action="set-provider" data-v="chatgpt">deinen ChatGPT-Plan</a>.</p></div>`;
}

function renderChatBody() {
  const body = $('#cp-body');
  if (!body) return;
  if (!providerReady()) {
    body.innerHTML = setupCard();
    return;
  }
  if (!S.chat.messages.length) {
    const cid = currentCourseId();
    const k = cid && courseById(cid);
    const inViewer = S.route.name === 'viewer' && V.mountedFor && S.data.files[V.mountedFor];
    const qs = inViewer
      ? ['Erkläre mir die aktuelle Seite Schritt für Schritt.', 'Fasse dieses Dokument mit den wichtigsten Formeln zusammen.', 'Erstelle 5 Übungsfragen zu diesem Dokument mit Lösungen.', 'Welche Begriffe aus diesem Dokument sollte ich für die Klausur können?']
      : k
        ? ['Fasse die wichtigsten Inhalte dieses Kurses zusammen.', 'Wo in den Unterlagen wird das zentrale Thema erklärt?', 'Erstelle mir Übungsfragen zum aktuellen Stoff.', 'Was steht in diesem Kurs als Nächstes an?']
        : ['Wo steht in meinen Unterlagen etwas zu …?', 'Was muss ich diese Woche erledigen?', 'Welche neuen Dateien gibt es und worum geht es darin?', 'Erstelle einen Lernplan für die nächsten 14 Tage.'];
    const p = PROVIDERS[prov()];
    body.innerHTML = `<div class="cp-empty">
      <div class="cp-logo ${p.cls}">${icon(p.icon)}</div>
      <h3>Was möchtest du verstehen?</h3>
      <p>${inViewer ? `Ich sehe <b>${esc(inViewer.filename)}</b>. Markiere Text im Dokument, um ihn erklären zu lassen.` : k ? `Du bist in <b>${esc(k.shortname || k.fullname)}</b>. Ich durchsuche die Unterlagen für dich.` : 'Ich durchsuche alle deine Skripte, Folien und Aufgaben und erkläre dir die Stellen.'}</p>
      <div class="suggestions">${qs.map((q) => `<div class="suggestion" data-action="${q.endsWith('…?') ? 'prefill' : 'ask'}" data-q="${esc(q.replace(' …?', ' '))}">${icon('sparkles', 'sm')}${esc(q)}</div>`).join('')}</div>
    </div>`;
    return;
  }
  body.innerHTML = S.chat.messages.map((m, i) => `<div class="msg ${m.role}" id="msg-${i}">${messageInner(m)}</div>`).join('');
  body.scrollTop = body.scrollHeight;
}

function messageInner(m) {
  if (m.role === 'user') {
    return `${m.attachments.length ? `<div class="att">${m.attachments.map((a) => `<span class="att-chip">${icon('file', 'sm')}<span>${esc(a)}</span></span>`).join('')}</div>` : ''}${m.quote ? `<div class="quote">${esc(m.quote.slice(0, 400))}${m.quote.length > 400 ? '…' : ''}</div>` : ''}<div class="bubble">${esc(m.text)}</div>`;
  }
  let html = '';
  for (const p of m.parts) {
    if (p.type === 'thinking' && p.text.trim()) html += `<details class="thinking"><summary>${icon('sparkles', 'sm')} Gedankengang</summary><div class="tbody">${esc(p.text)}</div></details>`;
    else if (p.type === 'steps') html += `<div class="steps">${p.items.map((s) => `<div class="step ${s.done ? 'done' : ''}">${s.done ? icon('check') : icon('refresh', 'spin')}${esc(s.label)}</div>`).join('')}</div>`;
    else if (p.type === 'text' && p.text) html += `<div class="md">${renderMd(p.text)}</div>`;
    else if (p.type === 'notice') html += `<div class="notice">${esc(p.text)}</div>`;
  }
  if (m.error) {
    let extra = '';
    if (m.errorKind === 'auth') extra = ' <a href="#" data-action="go" data-route="settings" data-tab="ai">Einstellungen öffnen</a>';
    if (m.errorKind === 'chatgpt-auth') extra = ' <a href="#" data-action="chatgpt-login">Erneut anmelden</a>';
    if (m.errorKind === 'chatgpt-limit') extra = ` <a href="#" data-action="external" data-url="${MANAGE_USAGE_URL}">Nutzung verwalten</a>`;
    html += `<div class="err">${esc(m.error)}${extra}</div>`;
  }
  if (m.streaming && !m.parts.some((p) => p.type === 'text' && p.text)) {
    const sec = m.startedAt ? Math.floor((Date.now() - m.startedAt) / 1000) : 0;
    html += `<div class="waiting"><span class="typing"><i></i><i></i><i></i></span><span>${sec < 3 ? 'Sendet…' : `Denkt nach… ${sec} s`}</span></div>`;
  }
  if (!m.streaming && m.parts.some((p) => p.type === 'text' && p.text)) html += `<div class="msg-tools"><button class="icon-btn sm" data-action="copy-msg" title="Kopieren">${icon('copy', 'sm')}</button></div>`;
  return html;
}

function renderCompose() {
  const el = $('#cp-compose');
  if (!el) return;
  if (!providerReady()) { el.innerHTML = ''; return; }
  const prev = $('#chat-input');
  const draft = prev ? prev.value : S.chat.draft || '';
  const hadFocus = prev && document.activeElement === prev;
  const gpt = prov() === 'chatgpt';
  el.innerHTML = `
    ${S.chat.attachments.length && !S.chat.busy ? `<div class="suggestions" style="flex-direction:row;flex-wrap:wrap;gap:6px;margin-bottom:8px">${['Fasse zusammen', 'Erkläre die schwierigsten Stellen', 'Erstelle Lernkarten', 'Erstelle Übungsfragen mit Lösungen'].map((q) => `<div class="suggestion" style="padding:6px 10px;font-size:12.5px" data-action="ask" data-q="${esc(q)}">${esc(q)}</div>`).join('')}</div>` : ''}
    <form class="compose-box" data-submit="claude-send">
      <div class="compose-chips" id="compose-chips">${composeChips()}</div>
      <textarea id="chat-input" rows="1" placeholder="Frag nach Inhalten deiner Unterlagen…" data-input="chat-input">${esc(draft)}</textarea>
      <div class="compose-actions"><small>${gpt ? `Nutzt deinen ChatGPT-Plan · <a href="#" data-action="external" data-url="${MANAGE_USAGE_URL}">Nutzung verwalten</a>` : 'Enter senden · Shift+Enter neue Zeile'}</small>
        ${S.chat.busy ? `<button type="button" class="send-btn" data-action="chat-stop" title="Stoppen">${icon('stop', 'sm')}</button>` : `<button class="send-btn" title="Senden">${icon('send', 'sm')}</button>`}
      </div>
    </form>`;
  autoGrow($('#chat-input'));
  if (hadFocus) $('#chat-input').focus();
}

function composeChips() {
  const chips = [];
  const ctx = chatContext();
  const off = !S.chat.ctxOn;
  if (S.route.name === 'viewer' && V.mountedFor && S.data.files[V.mountedFor]) {
    const f = S.data.files[V.mountedFor];
    chips.push(`<span class="att-chip ctx ${off ? 'off' : ''}" title="Geöffnetes Dokument als Kontext">${icon('filetext', 'sm')}<span>${esc(f.filename)} · <b id="ctx-page">S. ${V.page}</b></span><button type="button" data-action="ctx-toggle">${icon(off ? 'plus' : 'x', 'sm')}</button></span>`);
  } else {
    const cid = currentCourseId();
    const k = cid && courseById(cid);
    const mid = S.chat.moduleId || (S.route.name === 'module' ? Number(S.route.params.cmid) : null);
    const mh = mid && findModule(mid);
    if (k) chips.push(`<span class="att-chip ctx ${off ? 'off' : ''}" title="Kontext an die KI übergeben">${icon('book', 'sm')}<span>${esc(mh ? mh.mod.name : k.shortname || k.fullname)}</span><button type="button" data-action="ctx-toggle">${icon(off ? 'plus' : 'x', 'sm')}</button></span>`);
  }
  for (const id of S.chat.attachments) {
    const f = S.data.files[id];
    if (f) chips.push(`<span class="att-chip">${icon('file', 'sm')}<span>${esc(f.filename)}</span><button type="button" data-action="att-remove" data-file="${id}">${icon('x', 'sm')}</button></span>`);
  }
  void ctx;
  return chips.join('');
}

function renderClaudeContext() {
  if ($('#compose-chips')) $('#compose-chips').innerHTML = composeChips();
  if (!S.chat.messages.length) renderChatBody();
}

function autoGrow(t) {
  if (!t) return;
  t.style.height = 'auto';
  t.style.height = Math.min(180, t.scrollHeight) + 'px';
}

function openClaude() {
  if (!S.ui.claudeOpen) {
    S.ui.claudeOpen = true;
    $('#claude').classList.remove('closed');
    renderNav();
  }
}

function sendWithSelection() {
  const sel = S.chat.pendingSelection;
  S.chat.pendingSelection = null;
  if (sel) sendChat(undefined, { selection: sel.text, page: sel.page });
  else sendChat();
}

function sendChat(textArg, extra = {}) {
  if (S.chat.busy) return;
  if (!providerReady()) { openClaude(); return; }
  const input = $('#chat-input');
  const text = (textArg ?? (input ? input.value : '')).trim();
  if (!text) return;
  const chat = S.chat;
  const provider = prov();
  const attachments = [...chat.attachments];
  chat.messages.push({ role: 'user', text, quote: extra.selection || null, attachments: attachments.map((id) => (S.data.files[id] || {}).filename || id) });
  chat.messages.push({ role: 'assistant', parts: [], streaming: true, startedAt: Date.now() });
  chat.attachments = [];
  chat.busy = true;
  chat.draft = '';
  if (input) input.value = '';
  const context = chatContext();
  if (extra.selection) {
    context.selection = extra.selection;
    if (extra.page) context.page = extra.page;
  }
  chat.moduleId = null;
  renderChatBody();
  renderCompose();
  api.aiSend({ provider, conversationId: chat.id, text, attachments, context });
}

let rafPending = false;
function updateLastMessage() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    const i = S.chat.messages.length - 1;
    const el = $('#msg-' + i);
    const body = $('#cp-body');
    if (!el || !body) return renderChatBody();
    const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 120;
    const open = [...el.querySelectorAll('details')].map((d) => d.open);
    el.innerHTML = messageInner(S.chat.messages[i]);
    el.querySelectorAll('details').forEach((d, j) => (d.open = !!open[j]));
    if (nearBottom) body.scrollTop = body.scrollHeight;
  });
}

function onAiEvent(ev) {
  const chat = Object.values(S.chats).find((c) => c.id === ev.conversationId);
  if (!chat) return;
  const m = chat.messages[chat.messages.length - 1];
  if (!m || m.role !== 'assistant') return;
  const last = m.parts[m.parts.length - 1];
  const finishSteps = () => m.parts.forEach((p) => p.type === 'steps' && p.items.forEach((s) => (s.done = true)));
  switch (ev.type) {
    case 'thinking-start': finishSteps(); m.parts.push({ type: 'thinking', text: '' }); break;
    case 'thinking': if (last && last.type === 'thinking') last.text += ev.text; else m.parts.push({ type: 'thinking', text: ev.text }); break;
    case 'text-start': finishSteps(); m.parts.push({ type: 'text', text: '' }); break;
    case 'text': if (last && last.type === 'text') last.text += ev.text; else m.parts.push({ type: 'text', text: ev.text }); break;
    case 'tool': {
      let steps = last && last.type === 'steps' ? last : null;
      if (!steps) { steps = { type: 'steps', items: [] }; m.parts.push(steps); }
      steps.items.push({ label: ev.label, done: false });
      break;
    }
    case 'notice': m.parts.push({ type: 'notice', text: ev.message }); break;
    case 'retry': m.parts.push({ type: 'notice', text: 'Wiederhole Schritt…' }); break;
    case 'done':
      finishSteps(); m.streaming = false; chat.busy = false;
      if (!m.parts.some((p) => p.type === 'text' && p.text.trim())) m.error = 'Keine Antwort erhalten. Bitte noch einmal senden oder ein anderes Modell wählen.';
      break;
    case 'stopped': finishSteps(); m.streaming = false; chat.busy = false; m.parts.push({ type: 'notice', text: 'Gestoppt.' }); break;
    case 'error':
      finishSteps(); m.streaming = false; chat.busy = false; m.error = ev.message; m.errorKind = ev.kind;
      if (ev.kind === 'chatgpt-limit') showLimitModal();
      if (ev.kind === 'chatgpt-auth') refreshChatgpt();
      break;
  }
  if (chat !== S.chat) return;
  updateLastMessage();
  if (['done', 'stopped', 'error'].includes(ev.type)) renderCompose();
}

function showLimitModal() {
  showModal(`<h3>Nutzungslimit erreicht</h3>
    <p>Prüfe deinen Plan oder das Limit dieser App in den ChatGPT-Einstellungen.</p>
    <div class="row">${S.state.hasClaudeKey ? '<button class="btn" data-action="set-provider" data-v="claude">Zu Claude wechseln</button>' : '<button class="btn" data-action="modal-close">Schließen</button>'}
    <button class="btn primary" data-action="external" data-url="${MANAGE_USAGE_URL}">Nutzung verwalten</button></div>`);
}

function showWelcomeModal() {
  showModal(`<div class="cp-logo p-chatgpt" style="width:48px;height:48px;border-radius:14px;margin-bottom:12px">${icon('message')}</div>
    <h3>Du nutzt deinen ChatGPT-Plan</h3>
    <p>Berechtigte KI-Anfragen in Chadoodle nutzen deinen ChatGPT-Plan${S.chatgpt && S.chatgpt.email ? ` (${esc(S.chatgpt.email)})` : ''}. Die Nutzung verwaltest du in deinen ChatGPT-Einstellungen – dort kannst du auch ein Wochenlimit für diese App setzen.</p>
    <div class="row"><button class="btn" data-action="external" data-url="${MANAGE_USAGE_URL}">Nutzung verwalten</button><button class="btn primary" data-action="welcome-ok">Verstanden</button></div>`);
}

async function refreshChatgpt(loadModels = false) {
  S.chatgpt = await api.chatgptStatus();
  if (loadModels && S.chatgpt.signedIn) {
    try { S.gptModels = await api.chatgptModels(true); } catch { S.gptModels = S.gptModels || []; }
  }
  renderClaude();
  if (S.route.name === 'settings' && S.ui.settingsTab === 'ai') renderMain();
}

// ---------- Aktionen ----------
function indexText() {
  const st = S.index;
  if (!st) return '–';
  return `${st.indexed} von ${st.total} Dokumenten${st.running ? ' · läuft…' : ''}`;
}

async function openFile(id, external = false) {
  const f = S.data.files[id];
  if (f && !external && canRead(f)) return openDoc(id);
  if (f && !f.downloaded) toast(`Lade ${f.filename}…`);
  try {
    await api.openFile(id);
  } catch (e) {
    toast(cleanErr(e), true);
  }
}

function attachFile(id) {
  if (id && !S.chat.attachments.includes(id)) S.chat.attachments.push(id);
  openClaude();
  renderCompose();
  setTimeout(() => $('#chat-input') && $('#chat-input').focus(), 50);
}

const actions = {
  'mensa-day': (el) => { S.mensa.day = el.dataset.v; renderMain(); },
  'mensa-refresh': () => loadMensa(true),
  'mensa-order': () => { closeModal(); api.mensaOrder(); },
  'mensa-default': async () => {
    S.mensa.busy = true;
    renderMain();
    try {
      S.mensa.data = await api.mensaSetUrl(S.mensa.defaultUrl);
      S.mensa.url = S.mensa.defaultUrl;
      S.mensa.form = '';
      S.mensa.day = null;
    } catch (e) {
      toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true);
    } finally {
      S.mensa.busy = false;
      loadMensa();
    }
  },
  'mensa-dish': (el) => {
    const day = S.mensa.data && S.mensa.data.days.find((x) => x.date === S.mensa.day);
    const e = day && day.dishes[Number(el.dataset.i)];
    if (!e) return;
    const { diet, allergens } = dishTags(e);
    showModal(`${e.image ? `<img class="dish-big" src="${esc(e.image)}" alt="" />` : ''}
      <div class="dish-cat">${esc(e.category)}</div><h3>${esc(e.title)}</h3>
      ${e.description ? `<p>${esc(e.description)}</p>` : ''}
      ${diet ? `<div class="dish-tags-row">${diet}</div>` : ''}
      <dl class="kv small" style="margin-top:12px">
        ${e.prices.dhbw != null ? `<dt>DHBW</dt><dd>${euro(e.prices.dhbw)}</dd>` : ''}
        ${e.prices.intern != null ? `<dt>Intern</dt><dd>${euro(e.prices.intern)}</dd>` : ''}
        ${e.prices.extern != null ? `<dt>Extern</dt><dd>${euro(e.prices.extern)}</dd>` : ''}
        ${allergens.length ? `<dt>Enthält</dt><dd>${esc(allergens.join(', '))}</dd>` : ''}
      </dl>
      <div class="row"><button class="btn" data-action="modal-close">Schließen</button><button class="btn primary" data-action="mensa-order">${icon('clipboard', 'sm')} Bestellen</button></div>`);
  },
  'tt-week': (el) => { S.tt.week = ttAddDays(S.tt.week, 7 * Number(el.dataset.d)); loadTimetable(); },
  'tt-today': () => { S.tt.week = ttMonday(new Date()); loadTimetable(); },
  'tt-select': async (el) => { S.tt.active = el.dataset.id; await api.ttSelect(el.dataset.id); loadTimetable(true); },
  'tt-remove': async (el) => {
    const x = S.tt.list.find((p) => p.id === el.dataset.id);
    if (!x || !confirm(`Stundenplan „${x.name}“ entfernen?`)) return;
    await api.ttRemove(x.id);
    loadTimetable(true);
  },
  'tt-template': () => { S.tt.form = { name: S.tt.template.name, url: S.tt.template.url }; renderMain(); },
  'tt-refresh': async () => {
    S.tt.busy = true;
    renderMain();
    await api.ttRefresh().catch(() => {});
    S.tt.busy = false;
    loadTimetable(true);
  },
  'tt-event': (el) => {
    const e = S.tt.events[Number(el.dataset.i)];
    if (!e) return;
    const day = new Date(e.start).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
    showModal(`<h3>${esc(e.title)}</h3>
      <dl class="kv"><dt>Wann</dt><dd>${day}, ${ttClock(e.start)}–${ttClock(e.end)}</dd>
      ${e.location ? `<dt>Raum</dt><dd>${esc(e.location)}</dd>` : ''}
      ${e.persons.length ? `<dt>Dozent</dt><dd>${esc(e.persons.join(', '))}</dd>` : ''}
      ${e.category ? `<dt>Art</dt><dd>${esc(e.category)}</dd>` : ''}</dl>
      <div class="row"><button class="btn" data-action="modal-close">Schließen</button></div>`);
  },
  go: (el) => {
    if (el.dataset.tab) S.ui.settingsTab = el.dataset.tab;
    go(el.dataset.route);
  },
  course: (el) => go('course', { id: Number(el.dataset.id), tab: 'content' }),
  'course-tab': (el) => go('course', { ...S.route.params, tab: el.dataset.v }),
  module: (el) => {
    const hit = findModule(el.dataset.cmid);
    if (hit) go('module', { courseId: hit.courseId, cmid: hit.mod.id });
  },
  activity: (el, e) => {
    const hit = findModule(el.dataset.cmid);
    if (!hit) return;
    const m = hit.mod;
    const files = filesOfModule(m);
    if (m.modname === 'resource' && files.length === 1) return openFile(files[0].id);
    if (m.modname === 'folder') {
      S.ui.openFolders[m.id] = !S.ui.openFolders[m.id];
      return renderMain();
    }
    if (m.modname === 'url' && m.contents[0]) return api.openExternal(m.contents[0].fileurl);
    go('module', { courseId: hit.courseId, cmid: m.id });
  },
  external: (el) => el.dataset.url && api.openExternal(el.dataset.url),
  'open-site': () => api.openExternal(S.data.site.url + '/my/'),
  'open-file': (el) => openFile(el.dataset.file),
  'show-file': async (el) => { try { await api.showFile(el.dataset.file); } catch (e) { toast(cleanErr(e), true); } },
  'open-folder': (el) => api.openFolder(el.dataset.id ? Number(el.dataset.id) : null),
  'download-missing': async (el) => {
    const list = Object.values(S.data.files).filter((f) => f.courseId === Number(el.dataset.id) && !f.downloaded);
    toast(`Lade ${list.length} Dateien…`);
    for (const f of list) { try { await api.fileUrl(f.id); } catch {} }
    S.data = await api.data();
    renderMain();
    toast('Fertig');
  },
  sync: () => { api.sync(); toast('Synchronisation gestartet'); },
  'toggle-left': () => { S.ui.leftOpen = !S.ui.leftOpen; renderLeft(); renderMain(); },
  'toggle-claude': () => { S.ui.claudeOpen = !S.ui.claudeOpen; $('#claude').classList.toggle('closed', !S.ui.claudeOpen); renderNav(); if (S.ui.claudeOpen) setTimeout(() => $('#chat-input') && $('#chat-input').focus(), 220); },
  dropdown: (el) => { S.ui.dropdown = S.ui.dropdown === el.dataset.dd ? null : el.dataset.dd; renderNav(); },
  'clear-news': async () => { await api.clearNews(); S.data = await api.data(); S.ui.dropdown = null; renderNav(); renderMain(); },
  'tl-range': (el) => { S.ui.tlRange = el.dataset.v; renderMain(); },
  'course-filter': (el) => { S.ui.courseFilter = el.dataset.v; renderMain(); },
  'course-view': (el) => { S.ui.courseView = el.dataset.v; renderMain(); },
  'section-toggle': (el) => { S.ui.collapsed[el.dataset.key] = !S.ui.collapsed[el.dataset.key]; el.closest('.section').classList.toggle('collapsed'); },
  'collapse-all': (el) => {
    const id = Number(el.dataset.id);
    for (const s of S.data.contents[id] || []) S.ui.collapsed[`s-${id}-${s.id}`] = el.dataset.v === '1';
    renderMain();
  },
  'ci-toggle': (el) => {
    const sec = document.getElementById('sec-' + el.dataset.section);
    if (sec && S.route.name === 'course' && (S.route.params.tab || 'content') === 'content') {
      S.ui.collapsed[`s-${currentCourseId()}-${el.dataset.section}`] = false;
      sec.classList.remove('collapsed');
      sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      S.ui.collapsed[el.dataset.key] = !S.ui.collapsed[el.dataset.key];
      el.parentElement.classList.toggle('collapsed');
    }
  },
  'settings-tab': (el) => { S.ui.settingsTab = el.dataset.v; renderMain(); },
  'pick-folder': async () => {
    const dir = await api.pickFolder();
    if (!dir) return;
    S.state.settings = await api.setSettings({ downloadDir: dir });
    renderMain();
    toast('Download-Ordner geändert – Dateien werden neu geladen');
  },
  'set-theme': async (el) => {
    S.state.settings = await api.setSettings({ theme: el.dataset.v });
    applyTheme(el.dataset.v);
    renderMain();
  },
  'remove-key': async () => { await api.setClaudeKey(null); S.state = await api.state(); renderMain(); renderClaude(); },
  'set-provider': async (el) => {
    closeModal();
    S.state.settings = await api.setSettings({ aiProvider: el.dataset.v });
    if (el.dataset.v === 'chatgpt' && S.chatgpt && S.chatgpt.signedIn && !S.gptModels) {
      api.chatgptModels().then((m) => { S.gptModels = m; renderClaude(); if (S.route.name === 'settings') renderMain(); }).catch(() => {});
    }
    renderClaude();
    if (S.route.name === 'settings') renderMain();
  },
  'chatgpt-login': async (el) => {
    S.gptLogin = true;
    renderClaude();
    if (S.route.name === 'settings') renderMain();
    try {
      const st = await api.chatgptLogin({ switchAccount: !!(el && el.dataset && el.dataset.switch === '1') });
      S.chatgpt = st;
      S.state.settings = await api.setSettings({ aiProvider: 'chatgpt' });
      if (!st.welcomed) showWelcomeModal();
      toast('Mit ChatGPT verbunden');
    } catch (e) {
      const msg = cleanErr(e);
      if (!/abgebrochen/.test(msg)) toast(msg, true);
    }
    S.gptLogin = false;
    await refreshChatgpt(true);
  },
  'chatgpt-switch': () => actions['chatgpt-login']({ dataset: { switch: '1' } }),
  'chatgpt-cancel': () => api.chatgptCancel(),
  'chatgpt-logout': async () => { await api.chatgptLogout(); S.gptModels = null; await refreshChatgpt(); toast('Von ChatGPT abgemeldet'); },
  'chatgpt-models': async () => { await refreshChatgpt(true); },
  'welcome-ok': () => { api.chatgptWelcomed(); closeModal(); },
  'set-effort': async (el) => {
    S.state.settings = await api.setSettings({ aiEffort: el.dataset.v });
    renderClaude();
    if (S.route.name === 'settings') renderMain();
  },
  'chatgpt-log': () => api.chatgptOpenLog(),
  prefill: (el) => { openClaude(); const t = $('#chat-input'); if (t) { t.value = el.dataset.q; S.chat.draft = el.dataset.q; t.focus(); autoGrow(t); } },
  'open-doc': (el) => openDoc(el.dataset.file, Number(el.dataset.page) || 1, el.dataset.q || ''),
  'open-file-external': (el) => openFile(el.dataset.file, true),
  'viewer-back': () => goBack(),
  back: () => goBack(),
  'viewer-page': (el) => goToPage(V.page + Number(el.dataset.d)),
  'viewer-zoom': (el) => {
    if (!V.ctl) return;
    const z = el.dataset.z;
    if (z === 'fit') V.ctl.setZoom('fit');
    else V.ctl.zoomBy(z === 'in' ? 1.2 : 1 / 1.2);
    updateViewerBar();
  },
  'viewer-hit': (el) => { V.hitIdx = Number(el.dataset.i); goToPage(V.hits[V.hitIdx].page); },
  'viewer-hits-close': () => { $('#viewer-hitlist').hidden = true; },
  'viewer-ask': (el) => {
    openClaude();
    const f = S.data.files[V.mountedFor];
    if (!f || !providerReady()) return;
    S.chat.ctxOn = true;
    if (el.dataset.mode === 'summary') sendChat(`Fasse das Dokument „${f.filename}“ strukturiert zusammen: Kernaussagen, wichtige Formeln und Begriffe – mit Seitenangaben.`);
    else sendChat(`Erkläre mir Seite ${V.page} von „${f.filename}“ verständlich: worum geht es, was sind die Kernideen, und wie hängen Formeln und Abbildungen zusammen?`);
  },
  'sel-ask': (el) => {
    const sel = V.sel;
    $('#sel-bubble').hidden = true;
    if (!sel) return;
    if (el.dataset.mode === 'search') return runSearch(sel.text.slice(0, 120));
    openClaude();
    if (!providerReady()) return;
    S.chat.ctxOn = true;
    if (el.dataset.mode === 'explain') sendChat('Erkläre mir die markierte Stelle verständlich, mit dem Zusammenhang aus dem Dokument.', { selection: sel.text, page: sel.page });
    else {
      S.chat.pendingSelection = sel;
      const t = $('#chat-input');
      if (t) { t.placeholder = 'Deine Frage zur markierten Stelle…'; t.focus(); }
    }
  },
  logout: () => {
    S.ui.dropdown = null;
    renderNav();
    showModal(`<h3>Abmelden?</h3><p>Die Hintergrund-Synchronisation wird beendet.</p>
      <label class="check"><input type="checkbox" id="del-files" /> Heruntergeladene Dateien ebenfalls löschen</label>
      <div class="row"><button class="btn" data-action="modal-close">Abbrechen</button><button class="btn primary" data-action="logout-confirm">Abmelden</button></div>`);
  },
  'logout-confirm': async () => {
    const deleteFiles = $('#del-files').checked;
    closeModal();
    await api.logout({ deleteFiles });
    S.state = await api.state();
    S.data = null;
    unmountViewer();
    S.chats = { claude: newChat(), chatgpt: newChat() };
    S.route = { name: 'dashboard', params: {} };
    S.history = [];
    render();
  },
  'modal-close': () => closeModal(),
  'update-check': () => { api.updateCheck(); S.update = { ...S.update, state: 'checking' }; renderMain(); },
  'update-install': () => api.updateInstall(),
  'update-later': () => { S.updateDismissed = S.update.version; renderUpdateBanner(); },
  'login-back': () => { S.login.step = 'site'; S.login.error = ''; render(); },
  'login-sso': async () => {
    S.login.busy = true; S.login.error = ''; render();
    try {
      await api.login({ siteUrl: S.login.site.url, sso: true });
      await loginDone();
    } catch (e) {
      S.login.busy = false;
      const msg = cleanErr(e);
      S.login.error = /abgebrochen/.test(msg) ? '' : msg;
      render();
    }
  },
  ask: (el) => { openClaude(); if (providerReady()) sendChat(el.dataset.q); },
  'ask-file': (el) => (el.dataset.file ? attachFile(el.dataset.file) : actions['ask-module'](el)),
  'ask-module': (el) => {
    const hit = findModule(el.dataset.cmid);
    if (!hit) return;
    S.chat.moduleId = hit.mod.id;
    S.chat.ctxOn = true;
    for (const f of filesOfModule(hit.mod).slice(0, 5)) if (!S.chat.attachments.includes(f.id)) S.chat.attachments.push(f.id);
    openClaude();
    renderCompose();
    setTimeout(() => $('#chat-input') && $('#chat-input').focus(), 50);
  },
  'att-remove': (el) => { S.chat.attachments = S.chat.attachments.filter((x) => x !== el.dataset.file); renderCompose(); },
  'ctx-toggle': () => { S.chat.ctxOn = !S.chat.ctxOn; if (!S.chat.ctxOn) S.chat.moduleId = null; renderCompose(); },
  'chat-new': () => { api.aiReset(prov(), S.chat.id); S.chats[prov()] = newChat(); renderClaude(); },
  'chat-stop': () => api.aiStop(prov(), S.chat.id),
  'copy-msg': (el) => {
    const i = Number(el.closest('.msg').id.replace('msg-', ''));
    const m = S.chat.messages[i];
    navigator.clipboard.writeText(m.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n\n'));
    toast('Kopiert');
  },
};

function showModal(inner) {
  closeModal();
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.id = 'modal';
  bg.innerHTML = `<div class="modal">${inner}</div>`;
  bg.addEventListener('click', (e) => e.target === bg && closeModal());
  document.body.appendChild(bg);
}
function closeModal() { const m = $('#modal'); if (m) m.remove(); }

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (el) {
    e.preventDefault();
    e.stopPropagation();
    const fn = actions[el.dataset.action];
    if (fn) fn(el, e);
    if (S.ui.dropdown && !['dropdown'].includes(el.dataset.action) && !el.closest('.dropdown')) { S.ui.dropdown = null; renderNav(); }
    return;
  }
  // Links in Moodle-/Claude-Inhalten extern öffnen
  const a = e.target.closest('a[href]');
  if (a) {
    e.preventDefault();
    const href = a.getAttribute('href');
    if (href.startsWith('doc://')) {
      const u = new URL(href);
      const id = u.hostname || u.pathname.replace(/^\/+/, '');
      if (S.data.files[id]) openDoc(id, Number(u.searchParams.get('page')) || 1);
      else toast('Dokument nicht gefunden', true);
      return;
    }
    if (/^https?:/i.test(href)) api.openExternal(href);
    else if (href.startsWith('mfile://file/')) api.openExternal(decodeURIComponent(href.slice('mfile://file/'.length)));
    return;
  }
  if (S.ui.dropdown && !e.target.closest('.dropdown')) { S.ui.dropdown = null; renderNav(); }
  const bubble = $('#sel-bubble');
  if (bubble && !e.target.closest('#sel-bubble') && !String(window.getSelection() || '').trim()) bubble.hidden = true;
});

document.addEventListener('submit', (e) => {
  const form = e.target.closest('[data-submit]');
  if (!form) return;
  e.preventDefault();
  const fn = submits[form.dataset.submit];
  if (fn) fn(form);
});

document.addEventListener('input', (e) => {
  const k = e.target.dataset && e.target.dataset.input;
  if (k === 'course-search') { S.ui.courseSearch = e.target.value; renderMain(); }
  else if (k === 'file-search') { S.ui.fileSearch = e.target.value; renderMain(); }
  else if (k === 'tt-form') S.tt.form[e.target.dataset.key] = e.target.value;
  else if (k === 'mensa-form') S.mensa.form = e.target.value;
  else if (k === 'chat-input') { S.chat.draft = e.target.value; autoGrow(e.target); }
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  const k = t.dataset && t.dataset.change;
  if (!k) return;
  if (k === 'course-sort') { S.ui.courseSort = t.value; renderMain(); return; }
  const patch = { [t.dataset.key]: k === 'setting-bool' ? t.checked : k === 'setting-num' ? Number(t.value) : t.value };
  S.state.settings = await api.setSettings(patch);
  if (t.dataset.key === 'claudeModel' || t.dataset.key === 'chatgptModel') renderClaude();
  if (/^mensa(MinBreak|PickupFrom|PickupTo)$/.test(t.dataset.key) && S.route.name === 'mensa') renderMain();
  toast('Gespeichert');
});

document.addEventListener('keydown', (e) => {
  if (e.target.id === 'chat-input' && e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendWithSelection();
  }
  if (e.target.id === 'viewer-page' && e.key === 'Enter') {
    e.preventDefault();
    goToPage(Number(e.target.value) || 1);
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f' && S.state && S.state.loggedIn) {
    e.preventDefault();
    const q = $('#nav-q');
    if (q) { q.focus(); q.select(); }
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && S.route.name === 'viewer') {
    e.preventDefault();
    $('#viewer-q').focus();
    $('#viewer-q').select();
  }
  if (S.route.name === 'viewer' && (e.ctrlKey || e.metaKey) && V.ctl && ['+', '=', '-', '0'].includes(e.key)) {
    e.preventDefault();
    if (e.key === '0') V.ctl.setZoom('fit');
    else V.ctl.zoomBy(e.key === '-' ? 1 / 1.2 : 1.2);
    updateViewerBar();
  }
  if (S.route.name === 'viewer' && !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) {
    if (e.key === 'PageDown' || e.key === 'ArrowRight') { e.preventDefault(); goToPage(V.page + 1); }
    if (e.key === 'PageUp' || e.key === 'ArrowLeft') { e.preventDefault(); goToPage(V.page - 1); }
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && S.state && S.state.loggedIn) {
    e.preventDefault();
    actions['toggle-claude']();
  }
  if (e.key === 'Escape') {
    if ($('#modal')) closeModal();
    else if (S.ui.dropdown) { S.ui.dropdown = null; renderNav(); }
  }
});

document.addEventListener('mouseup', (e) => {
  if (e.button === 3 && S.state && S.state.loggedIn) { e.preventDefault(); goBack(); }
});
document.addEventListener('keydown', (e) => {
  if (e.altKey && e.key === 'ArrowLeft' && S.state && S.state.loggedIn) { e.preventDefault(); goBack(); }
});

// Wartezeit im Chat hochzählen
setInterval(() => {
  const m = S.chats && S.chat && S.chat.messages[S.chat.messages.length - 1];
  if (m && m.streaming && !m.parts.some((p) => p.type === 'text' && p.text)) updateLastMessage();
}, 1000);

// Relative Zeitangaben aktuell halten
setInterval(() => S.state && S.state.loggedIn && renderSyncPill(), 30000);

boot();
