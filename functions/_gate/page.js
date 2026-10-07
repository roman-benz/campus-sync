// Login-Seite vor der Website (Supabase Auth: E-Mail + Passwort). Wird von der Middleware für
// jede Seite ausgeliefert, solange kein gültiges Zugangs-Cookie da ist.
import { SUPABASE_URL, SUPABASE_KEY } from './cookie.js';

export function gatePage(nonce) {
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Chadoodle – Anmelden</title>
<link rel="icon" href="/icon.png" />
<style>
  :root { --bg: #f5f7fa; --card: #fff; --text: #1d2129; --muted: #5f6673; --line: #dde1e7; --input: #fff; --accent: #e8743b; --accent-text: #fff; --err: #c4320a; --ok: #1f7a4d; }
  @media (prefers-color-scheme: dark) { :root { --bg: #14161a; --card: #1d2026; --text: #e8eaed; --muted: #9aa1ad; --line: #2e333b; --input: #16181d; --err: #ff8a65; --ok: #6fcf97; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--text); font: 15px/1.5 "Segoe UI", system-ui, -apple-system, sans-serif; }
  .card { width: min(400px, 100%); background: var(--card); border: 1px solid var(--line); border-radius: 18px; padding: 28px; box-shadow: 0 10px 40px rgba(0,0,0,.12); }
  .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
  .brand img { width: 44px; height: 44px; border-radius: 12px; }
  h1 { font-size: 20px; margin: 0; }
  .sub { color: var(--muted); font-size: 13px; }
  label { display: block; font-size: 13px; font-weight: 600; margin: 12px 0 6px; }
  input { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line); background: var(--input); color: var(--text); font: inherit; }
  input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  button { width: 100%; margin-top: 18px; padding: 11px; border: 0; border-radius: 10px; background: var(--accent); color: var(--accent-text); font: inherit; font-weight: 600; cursor: pointer; }
  button[disabled] { opacity: .6; cursor: default; }
  .msg { margin-top: 14px; font-size: 13px; }
  .msg.err { color: var(--err); }
  .msg.ok { color: var(--ok); }
  .links { display: flex; justify-content: space-between; margin-top: 14px; font-size: 13px; }
  a { color: var(--accent); text-decoration: none; cursor: pointer; }
  .note { margin-top: 18px; color: var(--muted); font-size: 12px; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main class="card">
  <div class="brand"><img src="/icon.png" alt="" /><div><h1>Chadoodle</h1><div class="sub" id="title">Anmelden, um fortzufahren</div></div></div>
  <form id="form" novalidate>
    <div id="f-email"><label for="email">E-Mail</label><input id="email" type="email" autocomplete="username" required /></div>
    <div id="f-pw"><label for="pw">Passwort</label><input id="pw" type="password" autocomplete="current-password" minlength="8" required /></div>
    <button id="submit">Anmelden</button>
    <div class="msg" id="msg" role="status"></div>
  </form>
  <div class="links"><a id="l-mode">Konto anlegen</a><a id="l-forgot">Passwort vergessen?</a></div>
  <p class="note">Chadoodle im Browser ist derzeit nur für freigeschaltete Konten zugänglich.</p>
</main>
<script nonce="${nonce}">
const SB = ${JSON.stringify(SUPABASE_URL)};
const KEY = ${JSON.stringify(SUPABASE_KEY)};
const $ = (id) => document.getElementById(id);
let mode = 'login'; // login | register | forgot | reset
let recoveryToken = null;

function setMode(m) {
  mode = m;
  $('title').textContent = { login: 'Anmelden, um fortzufahren', register: 'Konto anlegen', forgot: 'Passwort zurücksetzen', reset: 'Neues Passwort festlegen' }[m];
  $('submit').textContent = { login: 'Anmelden', register: 'Konto anlegen', forgot: 'Link senden', reset: 'Passwort speichern' }[m];
  $('f-email').hidden = m === 'reset';
  $('f-pw').hidden = m === 'forgot';
  $('pw').autocomplete = m === 'login' ? 'current-password' : 'new-password';
  $('l-mode').textContent = m === 'login' ? 'Konto anlegen' : 'Zur Anmeldung';
  $('l-forgot').hidden = m !== 'login';
  msg('');
}
function msg(text, kind = 'err') {
  $('msg').textContent = text;
  $('msg').className = 'msg ' + kind;
}
async function auth(path, body, token) {
  const res = await fetch(SB + '/auth/v1/' + path, {
    method: path === 'user' ? 'PUT' : 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.msg || j.error_description || j.message || 'Fehler ' + res.status), { code: j.error_code || j.error });
  return j;
}
const ERRORS = {
  invalid_credentials: 'E-Mail oder Passwort stimmt nicht.',
  email_not_confirmed: 'Bitte bestätige zuerst deine E-Mail-Adresse (Link in der Bestätigungsmail).',
  user_already_exists: 'Für diese E-Mail gibt es schon ein Konto.',
  weak_password: 'Das Passwort ist zu schwach (mindestens 8 Zeichen).',
  over_email_send_rate_limit: 'Zu viele E-Mails – bitte in ein paar Minuten erneut versuchen.',
};
// Supabase-Sitzung gegen das Zugangs-Cookie der Website tauschen
async function enter(accessToken) {
  const res = await fetch('/api/gate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ access_token: accessToken }) });
  if (res.ok) return location.replace('/');
  const j = await res.json().catch(() => ({}));
  msg(j.error || 'Anmeldung fehlgeschlagen.');
}
const redirect = encodeURIComponent(location.origin + '/');

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('email').value.trim().toLowerCase();
  const password = $('pw').value;
  if (mode !== 'reset' && !email) return msg('Bitte E-Mail eingeben.');
  if (mode !== 'forgot' && password.length < 8) return msg('Das Passwort braucht mindestens 8 Zeichen.');
  $('submit').disabled = true;
  try {
    if (mode === 'login') {
      const s = await auth('token?grant_type=password', { email, password });
      await enter(s.access_token);
    } else if (mode === 'register') {
      await auth('signup?redirect_to=' + redirect, { email, password });
      setMode('login');
      msg('Fast geschafft: Bestätige deine E-Mail über den Link in der Mail, dann hier anmelden.', 'ok');
    } else if (mode === 'forgot') {
      await auth('recover?redirect_to=' + redirect, { email });
      msg('Falls es ein Konto gibt, ist ein Link zum Zurücksetzen unterwegs.', 'ok');
    } else if (mode === 'reset') {
      await auth('user', { password }, recoveryToken);
      await enter(recoveryToken);
    }
  } catch (err) {
    msg(ERRORS[err.code] || err.message);
  } finally {
    $('submit').disabled = false;
  }
});
$('l-mode').addEventListener('click', () => setMode(mode === 'login' ? 'register' : 'login'));
$('l-forgot').addEventListener('click', () => setMode('forgot'));

// Rückkehr aus einer Supabase-Mail (Bestätigung oder Passwort zurücksetzen): Tokens stehen im #-Teil
const h = new URLSearchParams(location.hash.slice(1));
history.replaceState(null, '', location.pathname);
if (h.get('error_description')) msg(h.get('error_description').replace(/\\+/g, ' '));
else if (h.get('access_token') && h.get('type') === 'recovery') {
  recoveryToken = h.get('access_token');
  setMode('reset');
} else if (h.get('access_token')) enter(h.get('access_token'));
$('email').focus();
</script>
</body>
</html>`;
}
