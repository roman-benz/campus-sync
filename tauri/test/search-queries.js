// Suchanfragen für den Vergleich alter (JS) und neuer (Rust) Volltextindex.
// Wird per `node tauri/cdp.mjs eval @tauri/test/search-queries.js` in der Debug-App ausgeführt
// und gibt alle Ergebnisse als JSON zurück.
(async () => {
  const idx = window.__chadoodleDebug.docIndex;
  const files = Object.values(window.__chadoodleDebug.sync.cache.files);
  const course = files.find((f) => /Signale/.test(f.filename + f.moduleName)) || files[0];
  const queries = [
    ['Laplace', {}],
    ['Laplace Transformation', {}],
    ['"Laplace Transformation"', {}],
    ['Größe', {}],
    ['Grosse', {}],
    ['Übertragungsfunktion', {}],
    ['uebertragungsfunktion', {}],
    ['Fourier Reihe Spektrum', {}],
    ['Spannung Strom Widerstand', {}],
    ['CAN Bus', {}],
    ['Projektmanagement', {}],
    ['Scrum Sprint', {}],
    ['Matrix Determinante', {}],
    ['Eigenwert', { limit: 5 }],
    ['Signal', { courseId: course.courseId }],
    ['Systeme', { fileId: course.id }],
    ['x', {}],
    ['', {}],
    ['zzzzqqq', {}],
    ['élève café naïve', {}],
    ['Prüfung Klausur', { perFile: 1 }],
    ['the and of', {}],
    ['C++ Zeiger', {}],
    ['Mikrocontroller Interrupt', { limit: 100, perFile: 10 }],
  ];
  const out = [];
  for (const [q, o] of queries) out.push({ q, o, r: await idx.search(q, o) });
  const pagesOf = Object.values(window.__chadoodleDebug.sync.cache.files).filter((f) => idx.isIndexed(f)).slice(0, 5);
  for (const f of pagesOf) out.push({ pages: f.id, r: await idx.getPages(f.id, 2, 4) });
  return JSON.stringify(out);
})()
