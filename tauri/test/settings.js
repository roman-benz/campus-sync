// Einstellungen öffnen, Theme wechseln und zurück, Einstellungen speichern – mit Fehlersammlung.
// node tauri/cdp.mjs eval @tauri/test/settings.js
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const errors = [];
  const onErr = (e) => errors.push(String(e.message || (e.reason && e.reason.message) || e.reason || e));
  window.addEventListener('error', onErr);
  window.addEventListener('unhandledrejection', onErr);
  const out = {};
  // Einstellungen über das Profilbild bzw. einen Einstellungen-Knopf
  const opener = [...document.querySelectorAll('button, a, [data-action]')].find((e) => /einstellungen/i.test(e.getAttribute('title') || e.getAttribute('aria-label') || e.dataset.action || e.textContent));
  const avatar = document.querySelector('header img, .avatar, [data-action="menu"], [data-action="profile"]');
  (opener || avatar)?.click();
  await sleep(800);
  const item = [...document.querySelectorAll('button, a, [data-action]')].find((e) => /^einstellungen$/i.test(e.textContent.trim()));
  item?.click();
  await sleep(1200);
  out.einstellungen = document.body.innerText.match(/Download-Ordner|Synchronisation|KI-Assistent/g)?.slice(0, 3).join(', ') || 'nicht gefunden';
  const before = (await api.state()).settings.theme;
  await api.setSettings({ theme: 'light' });
  await sleep(600);
  out.hellModus = matchMedia('(prefers-color-scheme: dark)').matches ? 'WebView meldet weiter dunkel' : 'WebView hell';
  await api.setSettings({ theme: before });
  await sleep(600);
  out.zurück = before + ' → ' + (matchMedia('(prefers-color-scheme: dark)').matches ? 'dunkel' : 'hell');
  const s = await api.setSettings({ syncIntervalMin: 45 });
  out.speichern = s.syncIntervalMin === 45 ? 'ok' : 'FEHLER';
  await api.setSettings({ syncIntervalMin: 60 });
  out.fehler = errors.length ? errors : 'keine';
  return JSON.stringify(out, null, 1);
})()
