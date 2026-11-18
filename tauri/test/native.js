// Rust-Teile, die sonst nur bei echten Anmeldungen laufen:
//  - SSO-Fenster fängt die Umleitung auf moodlemobile://token=… ab (Testserver: tauri/test/sso-server.mjs)
//  - lokaler Rückruf-Server (ChatGPT-/Passkey-Anmeldung) nimmt Anfragen an und antwortet
// node tauri/cdp.mjs eval @tauri/test/native.js
(async () => {
  const { invoke, Channel } = window.__TAURI__.core;
  const out = {};

  // 1) SSO-Fenster
  try {
    const url = await Promise.race([
      invoke('moodle_login_window', { launch: 'http://127.0.0.1:8799/launch' }),
      new Promise((_, j) => setTimeout(() => j(new Error('Zeitüberschreitung')), 15000)),
    ]);
    out.sso = url === 'moodlemobile://token=VEVTVA==' ? 'ok: ' + url : 'falsche Adresse: ' + url;
  } catch (e) {
    out.sso = 'FEHLER ' + e.message;
  }

  // 2) Rückruf-Server über das http-Ersatzmodul (wie chatgpt-auth.js / web-access.js)
  try {
    const ch = new Channel();
    let srv;
    const got = new Promise((resolve) => {
      ch.onmessage = (m) => {
        resolve(m);
        invoke('server_respond', { id: srv.id, req: m.req, status: 200, headers: [['Content-Type', 'text/plain']], body: 'antwort-' + m.url });
      };
    });
    srv = await invoke('server_listen', { port: 0, host: '127.0.0.1', onRequest: ch });
    const res = await fetch(`http://127.0.0.1:${srv.port}/auth/callback?code=abc&state=xyz`);
    const text = await res.text();
    const m = await got;
    await invoke('server_close', { id: srv.id });
    out.server = `Port ${srv.port}, Anfrage ${m.method} ${m.url}, Antwort ${res.status} "${text}"`;
    // gleicher Port belegt → EADDRINUSE (chatgpt-auth.js probiert dann den nächsten)
    const a = await invoke('server_listen', { port: 1455, host: '127.0.0.1', onRequest: new Channel() });
    out.inUse = await invoke('server_listen', { port: 1455, host: '127.0.0.1', onRequest: new Channel() }).then(() => 'FEHLER: kein Fehler', (e) => 'ok: ' + String(e).slice(0, 40));
    await invoke('server_close', { id: a.id });
  } catch (e) {
    out.server = 'FEHLER ' + e;
  }

  // 3) Benachrichtigung, DPAPI-Rundweg, SHA-256
  try {
    await invoke('notify', { title: 'Chadoodle-Test', body: 'Zeile 1\nZeile 2' });
    out.notify = 'ok';
  } catch (e) {
    out.notify = 'FEHLER ' + e;
  }
  return JSON.stringify(out, null, 1);
})()
