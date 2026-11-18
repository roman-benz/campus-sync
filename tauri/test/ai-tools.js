// KI-Werkzeuge gegen den echten Datenbestand ausführen (ohne KI-Anbieter): prüft, dass Suche,
// Seitenabruf, Dateien, Stundenplan und Mensa über die Tauri-Schichten funktionieren.
// node tauri/cdp.mjs eval @tauri/test/ai-tools.js
(async () => {
  const { aiTools, sync } = window.__chadoodleDebug;
  const files = Object.values(sync.cache.files);
  const pdf = files.find((f) => f.downloaded && /\.pdf$/i.test(f.filename) && f.filesize < 2e6);
  const big = files.find((f) => f.downloaded && /\.pdf$/i.test(f.filename) && f.filesize > 3e6);
  const img = files.find((f) => f.downloaded && /\.(png|jpe?g)$/i.test(f.filename));
  const out = {};
  const run = async (label, name, input, provider = 'claude') => {
    const t0 = performance.now();
    try {
      const r = await aiTools.run(name, input, provider);
      out[label] = (typeof r === 'string' ? r.slice(0, 160) : JSON.stringify(r).slice(0, 160)) + ` [${Math.round(performance.now() - t0)} ms]`;
    } catch (e) {
      out[label] = 'FEHLER ' + e.message;
    }
  };
  await run('search_documents', 'search_documents', { query: 'Laplace Transformation' });
  await run('read_pages', 'read_pages', { file_id: pdf.id, from_page: 1, to_page: 2 });
  await run('read_file (PDF, Claude)', 'read_file', { file_id: pdf.id });
  if (big) await run('read_file (großes PDF, ChatGPT)', 'read_file', { file_id: big.id }, 'chatgpt');
  if (img) await run('read_file (Bild)', 'read_file', { file_id: img.id });
  for (const name of ['list_courses', 'get_deadlines', 'get_timetable', 'get_mensa_menu']) await run(name, name, {});
  return JSON.stringify(out, null, 1);
})()
