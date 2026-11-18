// Entwicklungshilfe: JS in der laufenden Debug-App ausführen oder einen Screenshot machen
// (DevTools-Protokoll auf Port 9333, nur in Debug-Builds offen).
//   node tauri/cdp.mjs eval "document.title"
//   node tauri/cdp.mjs shot out.png
//   node tauri/cdp.mjs heap
import fs from 'node:fs';

let [cmd, arg, target = 'chadoodle.localhost'] = process.argv.slice(2);
if (cmd === 'eval' && arg.startsWith('@')) arg = fs.readFileSync(arg.slice(1), 'utf8');
const list = await (await fetch('http://127.0.0.1:9333/json')).json();
const page = list.find((p) => p.type === 'page' && p.url.includes(target)) || list.find((p) => p.type === 'page');
if (!page) throw new Error('keine Seite: ' + JSON.stringify(list.map((p) => p.url)));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
let n = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) pending.get(m.id)(m);
};
const call = (method, params = {}) =>
  new Promise((r) => {
    const id = ++n;
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });

if (cmd === 'eval') {
  const r = await call('Runtime.evaluate', { expression: arg, awaitPromise: true, returnByValue: true });
  const v = r.result?.result;
  console.log(r.result?.exceptionDetails ? 'EXCEPTION ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails) : typeof v?.value === 'string' ? v.value : JSON.stringify(v?.value ?? v, null, 1));
} else if (cmd === 'shot') {
  const r = await call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(arg, Buffer.from(r.result.data, 'base64'));
  console.log('gespeichert', arg);
} else if (cmd === 'heap') {
  // Speicher der JS-Heap nach Garbage Collection
  await call('HeapProfiler.enable');
  await call('HeapProfiler.collectGarbage');
  const h = await call('Runtime.getHeapUsage');
  console.log(`JS-Heap: ${(h.result.usedSize / 1048576).toFixed(1)} MB belegt, ${(h.result.totalSize / 1048576).toFixed(1)} MB reserviert`);
} else if (cmd === 'pages') {
  console.log(list.map((p) => `${p.type} ${p.url}`).join('\n'));
}
ws.close();
