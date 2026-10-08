// Seiten des Website-Zugangs: Login, Einladung einlösen, Admin-Dashboard.
// Eigenständiges HTML mit Skript-Nonce (strenge CSP), Stil wie die Chadoodle-Oberfläche.

export function page(nonce, title, body, script, { wide = false } = {}) {
  const html = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${title}</title>
<link rel="icon" href="/icon.png" />
<style>
  :root { --bg: #f5f7fa; --card: #fff; --text: #1d2129; --muted: #5f6673; --line: #dde1e7; --input: #fff; --soft: #f0f2f5; --accent: #e8743b; --accent-soft: #fdeee6; --err: #c4320a; --ok: #1f7a4d; }
  @media (prefers-color-scheme: dark) { :root { --bg: #14161a; --card: #1d2026; --text: #e8eaed; --muted: #9aa1ad; --line: #2e333b; --input: #16181d; --soft: #24282f; --accent-soft: #3a2a20; --err: #ff8a65; --ok: #6fcf97; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--text); font: 15px/1.5 "Segoe UI", system-ui, -apple-system, sans-serif; }
  .center { min-height: 100vh; display: grid; place-items: center; padding: 16px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 18px; padding: 24px; box-shadow: 0 10px 40px rgba(0,0,0,.10); }
  .narrow { width: min(400px, 100%); }
  .wrap { width: min(980px, 100%); margin: 0 auto; padding: 24px 16px 60px; }
  .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
  .brand img { width: 44px; height: 44px; border-radius: 12px; }
  h1 { font-size: 20px; margin: 0; } h2 { font-size: 16px; margin: 0 0 12px; }
  .sub, .muted { color: var(--muted); font-size: 13px; }
  label { display: block; font-size: 13px; font-weight: 600; margin: 12px 0 6px; }
  input, select { width: 100%; padding: 9px 12px; border-radius: 10px; border: 1px solid var(--line); background: var(--input); color: var(--text); font: inherit; }
  input[type=checkbox] { width: auto; margin-right: 6px; }
  input:focus, select:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  button, .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 9px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--card); color: var(--text); font: inherit; font-weight: 600; cursor: pointer; text-decoration: none; }
  button.primary, .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.block { width: 100%; margin-top: 16px; padding: 11px; }
  button.sm { padding: 5px 10px; font-size: 13px; }
  button.danger { color: var(--err); }
  button[disabled] { opacity: .6; cursor: default; }
  .msg { margin-top: 14px; font-size: 13px; min-height: 1em; } .msg.err { color: var(--err); } .msg.ok { color: var(--ok); }
  .top { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
  .top .grow { flex: 1; }
  .grid { display: grid; gap: 16px; }
  .row { display: flex; gap: 10px; align-items: end; flex-wrap: wrap; }
  .row > div { flex: 1; min-width: 160px; }
  .link-box { margin-top: 14px; padding: 12px; border-radius: 12px; background: var(--accent-soft); word-break: break-all; font-size: 13px; }
  .link-box .actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  .user { border-top: 1px solid var(--line); padding: 14px 0; }
  .user:first-of-type { border-top: 0; }
  .user-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .user-head b { font-size: 15px; }
  .chip { font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 99px; background: var(--soft); color: var(--muted); }
  .chip.admin { background: var(--accent-soft); color: var(--accent); }
  .keys { margin: 8px 0 0; padding: 0; list-style: none; }
  .keys li { display: flex; align-items: center; gap: 10px; padding: 6px 10px; border-radius: 10px; background: var(--soft); margin-top: 6px; font-size: 13px; }
  .keys li .grow { flex: 1; }
  .actions-row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td, th { text-align: left; padding: 8px 6px; border-top: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 600; border-top: 0; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
${body}
<script nonce="${nonce}">
${CLIENT}
${script}
</script>
</body>
</html>`;
  return html;
}

// WebAuthn im Browser: JSON-Optionen ↔ Binärdaten (ohne externe Bibliothek)
const CLIENT = `
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const b64e = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
const b64d = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)).buffer;
function msg(text, kind = 'err') { const m = $('msg'); if (!m) return; m.textContent = text; m.className = 'msg ' + kind; }
async function api(path, body, method) {
  const res = await fetch(path, { method: method || (body === undefined ? 'GET' : 'POST'), headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || 'Fehler ' + res.status);
  return j;
}
function credJSON(c) {
  const r = c.response;
  const out = { id: c.id, rawId: b64e(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults(), authenticatorAttachment: c.authenticatorAttachment || undefined, response: { clientDataJSON: b64e(r.clientDataJSON) } };
  if (r.attestationObject) {
    out.response.attestationObject = b64e(r.attestationObject);
    out.response.transports = r.getTransports ? r.getTransports() : [];
  } else {
    out.response.authenticatorData = b64e(r.authenticatorData);
    out.response.signature = b64e(r.signature);
    if (r.userHandle) out.response.userHandle = b64e(r.userHandle);
  }
  return out;
}
const passkeyError = (e) => e && e.name === 'NotAllowedError' ? 'Abgebrochen oder kein passender Passkey gefunden.' : e && e.name === 'InvalidStateError' ? 'Dieser Passkey ist schon registriert.' : (e && e.message) || 'Fehler';
async function createPasskey(start) {
  if (!window.PublicKeyCredential) throw new Error('Dieser Browser unterstützt keine Passkeys.');
  const { challengeId, options: o } = await api('/api/auth/register/options', start);
  const publicKey = { ...o, challenge: b64d(o.challenge), user: { ...o.user, id: b64d(o.user.id) }, excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: b64d(c.id) })) };
  const cred = await navigator.credentials.create({ publicKey });
  return api('/api/auth/register/verify', { challengeId, response: credJSON(cred), label: deviceLabel() });
}
async function usePasskey() {
  if (!window.PublicKeyCredential) throw new Error('Dieser Browser unterstützt keine Passkeys.');
  const { challengeId, options: o } = await api('/api/auth/login/options', {});
  const publicKey = { ...o, challenge: b64d(o.challenge), allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: b64d(c.id) })) };
  const cred = await navigator.credentials.get({ publicKey });
  return api('/api/auth/login/verify', { challengeId, response: credJSON(cred) });
}
function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Gerät';
  const br = /Edg\\//.test(ua) ? 'Edge' : /Firefox\\//.test(ua) ? 'Firefox' : /Chrome\\//.test(ua) ? 'Chrome' : /Safari\\//.test(ua) ? 'Safari' : '';
  return br ? os + ' · ' + br : os;
}
`;

const brand = (sub) => `<div class="brand"><img src="/icon.png" alt="" /><div><h1>Chadoodle</h1><div class="sub" id="sub">${sub}</div></div></div>`;

export function loginPage(nonce) {
  return page(nonce, 'Chadoodle – Anmelden', `<main class="center"><div class="card narrow">
    ${brand('Anmelden, um fortzufahren')}
    <button class="primary block" id="go">🔑 Mit Passkey anmelden</button>
    <div class="msg" id="msg" role="status"></div>
    <p class="muted" style="margin:18px 0 0">Chadoodle im Browser ist derzeit nur auf Einladung zugänglich. Den Einladungslink bekommst du vom Admin.</p>
  </div></main>`, `
  $('go').addEventListener('click', async () => {
    $('go').disabled = true; msg('');
    try { await usePasskey(); location.replace(location.pathname === '/admin' ? '/admin' : '/'); }
    catch (e) { msg(passkeyError(e)); }
    finally { $('go').disabled = false; }
  });`);
}

export function invitePage(nonce) {
  return page(nonce, 'Chadoodle – Einladung', `<main class="center"><div class="card narrow">
    ${brand('Einladung')}
    <div id="ok" hidden>
      <p style="margin:0 0 6px">Hallo <b id="name"></b>! Richte jetzt einen Passkey ein – damit meldest du dich künftig ohne Passwort an (Fingerabdruck, Gesicht oder Geräte-PIN).</p>
      <button class="primary block" id="go">🔑 Passkey einrichten</button>
    </div>
    <div class="msg" id="msg" role="status"></div>
  </div></main>`, `
  const token = location.hash.slice(1);
  history.replaceState(null, '', '/einladung');
  (async () => {
    if (!token) return msg('Im Link fehlt die Einladung.');
    try {
      const inv = await api('/api/auth/invite?token=' + encodeURIComponent(token));
      $('name').textContent = inv.name;
      if (inv.existing) $('sub').textContent = 'Weiteren Passkey hinzufügen';
      $('ok').hidden = false;
    } catch (e) { msg(e.message); }
  })();
  $('go').addEventListener('click', async () => {
    $('go').disabled = true; msg('');
    try { await createPasskey({ token }); msg('Passkey eingerichtet – du wirst angemeldet …', 'ok'); setTimeout(() => location.replace('/'), 700); }
    catch (e) { msg(passkeyError(e)); $('go').disabled = false; }
  });`);
}

export function forbiddenPage(nonce) {
  return page(nonce, 'Chadoodle – Kein Zugriff', `<main class="center"><div class="card narrow">${brand('Kein Zugriff')}<p>Das Admin-Dashboard ist nur für Admins.</p><a class="btn primary" href="/">Zur App</a></div></main>`, '');
}

export function adminPage(nonce, user) {
  return page(nonce, 'Chadoodle – Admin', `<div class="wrap">
    <div class="top">${brand('Admin · Zugang zur Website')}<div class="grow"></div>
      <span class="muted">Angemeldet als <b>${escapeHtml(user.name)}</b></span>
      <a class="btn" href="/">Zur App</a><button id="logout">Abmelden</button></div>
    <div class="grid">
      <section class="card">
        <h2>Einladung erstellen</h2>
        <p class="muted" style="margin:-6px 0 6px">Der Link funktioniert genau einmal. Wer ihn öffnet, richtet einen Passkey ein und ist danach angemeldet.</p>
        <div class="row">
          <div><label for="inv-name">Name</label><input id="inv-name" maxlength="60" placeholder="z. B. Lena" /></div>
          <div style="max-width:180px"><label for="inv-hours">Gültig</label><select id="inv-hours"><option value="24">24 Stunden</option><option value="72" selected>3 Tage</option><option value="168">7 Tage</option><option value="720">30 Tage</option></select></div>
          <div style="flex:0 0 auto;min-width:0"><label><input type="checkbox" id="inv-admin" /> Admin</label></div>
          <div style="flex:0 0 auto;min-width:0"><button class="primary" id="inv-create">Link erstellen</button></div>
        </div>
        <div id="inv-result"></div>
      </section>
      <section class="card"><h2>Nutzer</h2><div id="users" class="muted">Lade …</div></section>
      <section class="card"><h2>Einladungen</h2><div id="invites" class="muted">Lade …</div></section>
      <section class="card"><h2>Dieses Gerät</h2>
        <p class="muted" style="margin:-6px 0 10px">Einen weiteren Passkey für dein eigenes Konto hinzufügen (z. B. für dieses Handy oder einen Sicherheitsschlüssel).</p>
        <button id="add-self">🔑 Passkey auf diesem Gerät hinzufügen</button>
      </section>
      <div class="msg" id="msg" role="status"></div>
    </div>
  </div>`, `
  const fmt = (t) => t ? new Date(t * 1000).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–';
  let state = null;

  function showLink(link, name, expiresAt) {
    const subject = encodeURIComponent('Dein Zugang zu Chadoodle');
    const text = encodeURIComponent('Hallo ' + name + ',\\n\\nhier ist dein Einladungslink für Chadoodle im Browser. Öffne ihn und richte einen Passkey ein (einmalig gültig bis ' + fmt(expiresAt) + '):\\n\\n' + link + '\\n');
    $('inv-result').innerHTML = '<div class="link-box"><b>Einladung für ' + esc(name) + '</b> · gültig bis ' + esc(fmt(expiresAt)) + '<div style="margin-top:6px"><code id="link">' + esc(link) + '</code></div>' +
      '<div class="actions"><button class="sm primary" id="copy">Kopieren</button><a class="btn" style="padding:5px 10px;font-size:13px" href="mailto:?subject=' + subject + '&body=' + text + '">Per E-Mail</a>' +
      (navigator.share ? '<button class="sm" id="share">Teilen …</button>' : '') + '</div><div class="muted" style="margin-top:8px">Der Link wird nur jetzt angezeigt.</div></div>';
    $('copy').onclick = async () => { await navigator.clipboard.writeText(link); $('copy').textContent = 'Kopiert ✓'; };
    if ($('share')) $('share').onclick = () => navigator.share({ title: 'Chadoodle-Einladung', text: 'Dein Einladungslink für Chadoodle', url: link }).catch(() => {});
  }

  async function createInvite(body) {
    msg('');
    try { const r = await api('/api/admin/invites', body); showLink(r.link, body.name || (state.users.find((u) => u.id === body.userId) || {}).name, r.expiresAt); await load(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    catch (e) { msg(e.message); }
  }

  function render() {
    const me = state.me;
    $('users').innerHTML = state.users.length ? state.users.map((u) => '<div class="user"><div class="user-head"><b>' + esc(u.name) + '</b>' +
        (u.isAdmin ? '<span class="chip admin">Admin</span>' : '<span class="chip">Nutzer</span>') + (u.id === me ? '<span class="chip">du</span>' : '') +
        '<span class="muted">seit ' + esc(fmt(u.createdAt)) + ' · ' + u.sessions + ' aktive Sitzung' + (u.sessions === 1 ? '' : 'en') + '</span></div>' +
        '<ul class="keys">' + (u.passkeys.length ? u.passkeys.map((k) => '<li><span>🔑</span><span class="grow">' + esc(k.label) + '<span class="muted"> · angelegt ' + esc(fmt(k.createdAt)) + ' · zuletzt ' + esc(fmt(k.lastUsedAt)) + '</span></span><button class="sm danger" data-del-key="' + esc(k.id) + '">Entfernen</button></li>').join('') : '<li class="muted">Kein Passkey – kann sich nicht anmelden</li>') + '</ul>' +
        '<div class="actions-row"><button class="sm" data-more="' + esc(u.id) + '">Link für weiteren Passkey</button>' +
        (u.id !== me ? '<button class="sm" data-logout="' + esc(u.id) + '">Überall abmelden</button><button class="sm" data-admin="' + esc(u.id) + '" data-v="' + (u.isAdmin ? 0 : 1) + '">' + (u.isAdmin ? 'Admin entziehen' : 'Zum Admin machen') + '</button><button class="sm danger" data-del-user="' + esc(u.id) + '">Löschen</button>' : '') +
        '</div></div>').join('') : 'Noch keine Nutzer.';
    const open = state.invites.filter((i) => !i.usedAt);
    const used = state.invites.filter((i) => i.usedAt);
    $('invites').innerHTML = (open.length || used.length) ? '<table><tr><th>Für</th><th>Erstellt</th><th>Status</th><th></th></tr>' +
      open.map((i) => '<tr><td>' + esc(i.name) + (i.userId ? ' <span class="chip">weiterer Passkey</span>' : i.isAdmin ? ' <span class="chip admin">Admin</span>' : '') + '</td><td>' + esc(fmt(i.createdAt)) + '</td><td>offen bis ' + esc(fmt(i.expiresAt)) + '</td><td><button class="sm danger" data-revoke="' + esc(i.hash) + '">Zurückziehen</button></td></tr>').join('') +
      used.map((i) => '<tr><td>' + esc(i.name) + '</td><td>' + esc(fmt(i.createdAt)) + '</td><td>eingelöst ' + esc(fmt(i.usedAt)) + '</td><td></td></tr>').join('') + '</table>' : 'Keine offenen Einladungen.';
  }

  async function load() { state = await api('/api/admin/state'); render(); }
  async function act(fn, confirmText) {
    if (confirmText && !confirm(confirmText)) return;
    msg('');
    try { await fn(); await load(); } catch (e) { msg(e.message); }
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if (d.more) createInvite({ userId: d.more, hours: 72 });
    else if (d.logout) act(() => api('/api/admin/users/' + d.logout + '/logout', {}), 'Diesen Nutzer auf allen Geräten abmelden?');
    else if (d.admin) act(() => api('/api/admin/users/' + d.admin, { isAdmin: d.v === '1' }, 'PATCH'));
    else if (d.delUser) act(() => api('/api/admin/users/' + d.delUser, {}, 'DELETE'), 'Nutzer samt aller Passkeys löschen?');
    else if (d.delKey) act(() => api('/api/admin/credentials/' + encodeURIComponent(d.delKey), {}, 'DELETE'), 'Diesen Passkey entfernen?');
    else if (d.revoke) act(() => api('/api/admin/invites/' + d.revoke, {}, 'DELETE'));
  });
  $('inv-create').onclick = () => createInvite({ name: $('inv-name').value.trim(), hours: Number($('inv-hours').value), isAdmin: $('inv-admin').checked }).then(() => { $('inv-name').value = ''; $('inv-admin').checked = false; });
  $('add-self').onclick = async () => { msg(''); try { await createPasskey({ add: true }); msg('Passkey hinzugefügt.', 'ok'); await load(); } catch (e) { msg(passkeyError(e)); } };
  $('logout').onclick = async () => { await api('/api/auth/logout', {}); location.replace('/'); };
  load().catch((e) => msg(e.message));`, { wide: true });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function securityHeaders(nonce) {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  };
}

export const newNonce = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
