// Noten-Reiter mit erfundenen Beispieldaten anzeigen (Layout-Prüfung, ohne Dualis-Zugang)
// node tauri/cdp.mjs eval @tauri/test/grades-sample.js
(() => {
  const m = (no, name, grade, status = grade ? 'Bestanden' : 'Offen') => ({ no, name, date: null, credits: 5, grade, status });
  S.dualis.st = {
    configured: true,
    user: 'test',
    busy: false,
    error: null,
    fetchedAt: Date.now() - 20 * 60 * 1000,
    data: {
      program: 'Beispiel-Studiengang',
      groups: [
        { title: '2024 Kernmodule', sum: { credits: 25 }, modules: [m('T4XX1001', 'Mathematik I', '1,7'), m('T4XX1002', 'Elektrotechnik I', '2,3'), m('T4XX1003', 'Programmieren I', '1,0'), m('T4XX1004', 'Physik', '4,7', 'Nicht bestanden'), m('T4XX2001', 'Mathematik III', null)] },
        { title: 'Wahlmodule', sum: null, modules: [m('T4XX9001', 'Projektmanagement', '1,3')] },
      ],
      total: { credits: 25 },
      required: 210,
      gpa: { total: '1,8', major: '1,7' },
    },
  };
  go('grades');
  return 'ok';
})()
