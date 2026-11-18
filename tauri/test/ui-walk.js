// Durch alle Bereiche der Oberfläche klicken und JS-Fehler sammeln.
// node tauri/cdp.mjs eval @tauri/test/ui-walk.js   (danach: window.__walk für Details)
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const errors = [];
  const onErr = (e) => errors.push(String(e.message || (e.reason && e.reason.message) || e.reason || e));
  window.addEventListener('error', onErr);
  window.addEventListener('unhandledrejection', onErr);
  const origErr = console.error;
  console.error = (...a) => {
    errors.push('console.error: ' + a.map(String).join(' ').slice(0, 200));
    origErr(...a);
  };
  const nav = (label) => {
    const el = [...document.querySelectorAll('nav button, nav a, header button, header a, [role=tab]')].find((e) => e.textContent.trim() === label);
    if (el) el.click();
    return !!el;
  };
  const report = {};
  for (const tab of ['Übersicht', 'Kurse', 'Fristen', 'Stundenplan', 'Mensa']) {
    const ok = nav(tab);
    await sleep(1500);
    const main = document.querySelector('main') || document.body;
    report[tab] = ok ? `${main.innerText.length} Zeichen, ${main.querySelectorAll('img').length} Bilder, ${[...main.querySelectorAll('img')].filter((i) => i.complete && !i.naturalWidth).length} kaputt` : 'Reiter nicht gefunden';
  }
  // Assistent öffnen und schließen
  const asst = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Assistent');
  if (asst) {
    asst.click();
    await sleep(1200);
    report.Assistent = document.body.innerText.includes('ChatGPT') || document.body.innerText.includes('Claude') ? 'Panel offen' : 'Panel ohne Anbieter-Text';
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }
  // Suche in der Kopfzeile
  const search = document.querySelector('input[placeholder*="Dokumenten"]');
  if (search) {
    search.focus();
    search.value = 'Fourier';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(1500);
    report.Suche = document.body.innerText.includes('Fourier') ? 'Treffer angezeigt' : 'keine Anzeige';
    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));
  }
  nav('Übersicht');
  await sleep(500);
  report.Fehler = errors.length ? errors : 'keine';
  window.__walk = report;
  return JSON.stringify(report, null, 1);
})()
