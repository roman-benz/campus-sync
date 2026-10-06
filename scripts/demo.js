// Demo-Modus mit Beispieldaten (ohne Moodle-Zugang): npm run demo
// Optional: --shots <ordner> erstellt Screenshots aller Ansichten und beendet die App.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(app.getPath('temp'), 'moodle-desktop-demo');
app.setPath('userData', path.join(root, 'userData'));
const shotsArg = process.argv.indexOf('--shots');
const shotsDir = shotsArg > -1 ? process.argv[shotsArg + 1] : null;
const SITE = 'https://moodle.demo.invalid';

// Minimaler PDF-Generator: ein Eintrag pro Seite, Zeilen mit \n getrennt
function pdf(pagesIn) {
  const pages = Array.isArray(pagesIn) ? pagesIn : [pagesIn];
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  for (const text of pages) {
    const lines = text.split('\n').map((l, i) => `BT /F1 ${i === 0 ? 18 : 12} Tf 60 ${770 - i * 22} Td (${l.replace(/[()\\]/g, '')}) Tj ET`).join('\n');
    objs.push(`<< /Length ${lines.length} >>\nstream\n${lines}\nendstream`);
    const contentRef = objs.length;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${contentRef} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    kids.push(`${objs.length} 0 R`);
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

const SKRIPT = [
  'Grundlagen der Elektrotechnik II\nKapitel 2 - Komplexe Wechselstromrechnung\n\nProf. Dr. Mueller - Sommersemester 2026',
  '2.1 Zeiger und komplexe Amplituden\n\nEine sinusfoermige Groesse u(t) = U * sqrt(2) * cos(wt + phi)\nwird durch den komplexen Zeiger U = U * e^(j phi) dargestellt.\nDie Kreisfrequenz w = 2 pi f ist fuer alle Groessen gleich.\nRechenregeln: Ableitung entspricht Multiplikation mit jw.',
  '2.2 Komplexe Impedanz\n\nWiderstand: Z_R = R\nSpule: Z_L = j w L   (Strom eilt der Spannung um 90 Grad nach)\nKondensator: Z_C = 1 / (j w C)   (Strom eilt um 90 Grad vor)\nReihenschaltung: Z = R + j(wL - 1/(wC))\nBetrag |Z| = sqrt(R^2 + X^2), Phase phi = arctan(X / R)',
  '2.3 Reihenschwingkreis und Resonanz\n\nResonanz tritt auf, wenn der Blindwiderstand X = 0 ist.\nResonanzfrequenz: w0 = 1 / sqrt(L C), also f0 = 1 / (2 pi sqrt(L C))\nBei Resonanz ist die Impedanz rein reell: Z = R, der Strom maximal.\nGuete: Q = (1/R) * sqrt(L/C)\nBandbreite: B = f0 / Q',
  '2.4 Leistung im Wechselstromkreis\n\nWirkleistung P = U I cos(phi)\nBlindleistung Q = U I sin(phi)\nScheinleistung S = U I, komplexe Leistung S = U * I^*\nLeistungsfaktor cos(phi) - Blindleistungskompensation mit Kondensatoren',
  'Uebungsaufgaben Kapitel 2\n\n1. Berechnen Sie die Resonanzfrequenz fuer L = 10 mH und C = 100 nF.\n2. Bestimmen Sie Guete und Bandbreite fuer R = 10 Ohm.\n3. Zeichnen Sie das Zeigerdiagramm bei f = 2 f0.',
];

function seed() {
  const store = require('../src/main/store');
  const { safeName } = require('../src/main/sync');
  const downloadDir = path.join(root, 'Moodle');
  store.setSettings({ siteUrl: SITE, downloadDir, syncIntervalMin: 240, notifications: false, runInBackground: false });
  store.setSecret('moodleToken', 'demo-token');

  const now = Math.floor(Date.now() / 1000);
  const day = 86400;
  let cm = 1000;
  const file = (name, size, mod = now - 5 * day) => ({ type: 'file', filename: name, filepath: '/', filesize: size, fileurl: `${SITE}/webservice/pluginfile.php/${cm}/mod_resource/content/0/${encodeURIComponent(name)}?forcedownload=1`, timemodified: mod, mimetype: name.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream' });
  const res = (name, f) => ({ id: ++cm, name, modname: 'resource', uservisible: true, contents: [f(name)], dates: [] });
  const courses = [
    { id: 11, fullname: 'Grundlagen der Elektrotechnik II', shortname: 'GET2', categoryname: 'Elektrotechnik · 2. Semester', progress: 62, lastaccess: now - 3600, startdate: now - 40 * day, enddate: now + 80 * day },
    { id: 12, fullname: 'Digitaltechnik', shortname: 'DT', categoryname: 'Elektrotechnik · 2. Semester', progress: 45, lastaccess: now - 2 * day, startdate: now - 40 * day, enddate: now + 80 * day, isfavourite: true },
    { id: 13, fullname: 'Mathematik II – Analysis & Lineare Algebra', shortname: 'MA2', categoryname: 'Grundlagen', progress: 30, lastaccess: now - 5 * day, startdate: now - 40 * day, enddate: now + 80 * day },
    { id: 14, fullname: 'Programmieren in C', shortname: 'PROG-C', categoryname: 'Informatik', progress: 88, lastaccess: now - 9 * day, startdate: now - 40 * day, enddate: now + 80 * day },
    { id: 15, fullname: 'Technisches Englisch', shortname: 'ENG', categoryname: 'Schlüsselqualifikationen', progress: null, lastaccess: now - 30 * day, startdate: now - 200 * day, enddate: now - 20 * day },
  ];
  const mk = (pdfName) => (n) => file(n, 180000 + n.length * 9000);
  const contents = {
    11: [
      { id: 1, section: 0, name: 'Allgemeines', summary: '<p>Willkommen im Kurs <b>GET II</b>! Vorlesung: Mo 8:00–11:15, Raum A2.04.</p>', modules: [
        { id: ++cm, name: 'Ankündigungen', modname: 'forum', uservisible: true, contents: [], dates: [] },
        res('Modulhandbuch GET2.pdf', mk()),
        { id: ++cm, name: 'Organisatorisches', modname: 'page', uservisible: true, contents: [], dates: [] },
      ] },
      { id: 2, section: 1, name: 'Kapitel 1 – Wechselstromkreise', summary: '', modules: [
        res('GET2_Kap1_Wechselstrom.pdf', mk()),
        res('Uebung1_Zeigerdiagramme.pdf', mk()),
        { id: ++cm, name: 'Formelsammlung & Tabellen', modname: 'folder', uservisible: true, contents: [file('Formelsammlung_GET.pdf', 412000), file('Normreihen_E12_E24.pdf', 88000)], dates: [] },
        { id: ++cm, name: '', modname: 'label', uservisible: true, description: '<p>💡 <b>Tipp:</b> Die Übungsblätter werden jeweils in der Folgewoche besprochen.</p>', contents: [], dates: [] },
      ] },
      { id: 3, section: 2, name: 'Kapitel 2 – Komplexe Wechselstromrechnung', summary: '<p>Impedanz, Admittanz, Leistung im Wechselstromkreis.</p>', modules: [
        res('GET2_Kap2_Komplexe_Rechnung.pdf', mk()),
        { id: 2001, name: 'Laborbericht 1: RLC-Schwingkreis', modname: 'assign', uservisible: true, contents: [], dates: [] },
        { id: ++cm, name: 'Online-Test Kapitel 2', modname: 'quiz', uservisible: true, contents: [], url: SITE + '/mod/quiz/view.php?id=9', dates: [{ label: 'Geöffnet:', timestamp: now - day }, { label: 'Schließt:', timestamp: now + 6 * day }] },
      ] },
      { id: 4, section: 3, name: 'Kapitel 3 – Drehstrom', summary: '', modules: [
        res('GET2_Kap3_Drehstrom.pdf', mk()),
        { id: ++cm, name: 'Simulation: Drehfeld (Falstad)', modname: 'url', uservisible: true, contents: [{ type: 'url', filename: 'Drehfeld', fileurl: 'https://www.falstad.com/circuit/' }], dates: [] },
      ] },
    ],
    12: [
      { id: 21, section: 0, name: 'Allgemeines', summary: '', modules: [{ id: ++cm, name: 'Ankündigungen', modname: 'forum', uservisible: true, contents: [], dates: [] }] },
      { id: 22, section: 1, name: 'Boolesche Algebra & KV-Diagramme', summary: '', modules: [res('DT_01_Boolesche_Algebra.pdf', mk()), res('DT_02_KV_Diagramme.pptx', mk())] },
      { id: 23, section: 2, name: 'Schaltwerke & FSM', summary: '', modules: [res('DT_03_Flipflops.pdf', mk()), { id: 2002, name: 'Projekt: Ampelsteuerung in VHDL', modname: 'assign', uservisible: true, contents: [], dates: [] }] },
    ],
    13: [{ id: 31, section: 1, name: 'Lineare Algebra', summary: '', modules: [res('MA2_Matrizen.pdf', mk()), res('MA2_Eigenwerte.pdf', mk()), { id: 2003, name: 'Hausaufgabe 4: Eigenwerte', modname: 'assign', uservisible: true, contents: [], dates: [] }] }],
    14: [{ id: 41, section: 1, name: 'Zeiger & Speicher', summary: '', modules: [res('C_Zeiger.pdf', mk()), res('beispiel_listen.c', mk())] }],
    15: [{ id: 51, section: 1, name: 'Technical Writing', summary: '', modules: [res('Technical_Writing_Guide.pdf', mk())] }],
  };
  const forumIds = {};
  for (const [cid, secs] of Object.entries(contents)) for (const s of secs) for (const m of s.modules) if (m.modname === 'forum') forumIds[cid] = m.id;
  const pageId = contents[11][0].modules[2].id;

  const cache = {
    site: { url: SITE, sitename: 'DHBW Ravensburg – Moodle (Demo)', fullname: 'Roman Benz', firstname: 'Roman', userid: 7, release: '4.4.3 (Build: 20240812)' },
    courses,
    contents,
    pages: { [pageId]: { name: 'Organisatorisches', content: '<h3>Prüfungsleistung</h3><p>Klausur (90 Min.) am Ende des Semesters. Zugelassene Hilfsmittel: <b>eine handschriftliche Formelsammlung (DIN A4, beidseitig)</b> und ein nicht programmierbarer Taschenrechner.</p><h3>Labor</h3><ul><li>3 Labortermine, Anwesenheitspflicht</li><li>Laborberichte in Zweiergruppen</li></ul>' } },
    assignments: {
      2001: { id: 1, courseid: 11, name: 'Laborbericht 1: RLC-Schwingkreis', duedate: now + 1 * day + 5 * 3600, cutoffdate: now + 3 * day, allowsubmissionsfromdate: now - 10 * day, intro: '<p>Erstellen Sie einen Laborbericht zum Versuch <b>RLC-Reihenschwingkreis</b>. Bestimmen Sie Resonanzfrequenz, Güte und Bandbreite und vergleichen Sie Messung und Rechnung.</p>', attachments: [{ filename: 'Versuchsanleitung_RLC.pdf', filepath: '/', filesize: 230000, fileurl: SITE + '/webservice/pluginfile.php/77/mod_assign/intro/Versuchsanleitung_RLC.pdf', timemodified: now - 9 * day }] },
      2002: { id: 2, courseid: 12, name: 'Projekt: Ampelsteuerung in VHDL', duedate: now + 9 * day, intro: '<p>Implementieren Sie eine Ampelsteuerung als Moore-Automat in VHDL.</p>', attachments: [] },
      2003: { id: 3, courseid: 13, name: 'Hausaufgabe 4: Eigenwerte', duedate: now + 4 * day + 2 * 3600, intro: '<p>Berechnen Sie die Eigenwerte und Eigenvektoren der Matrizen auf Blatt 4.</p>', attachments: [] },
    },
    forums: {
      [forumIds[11]]: { name: 'Ankündigungen', type: 'news', courseid: 11, discussions: [
        { id: 1, subject: 'Raumänderung am Montag', message: '<p>Die Vorlesung am Montag findet ausnahmsweise in <b>Raum B1.12</b> statt.</p>', author: 'Prof. Dr. Müller', created: now - day, modified: now - day, replies: 0, pinned: true },
        { id: 2, subject: 'Folien Kapitel 3 online', message: '<p>Die Folien zu Kapitel 3 (Drehstrom) sind jetzt verfügbar.</p>', author: 'Prof. Dr. Müller', created: now - 3 * day, modified: now - 3 * day, replies: 2 },
      ] },
      [forumIds[12]]: { name: 'Ankündigungen', type: 'news', courseid: 12, discussions: [] },
    },
    events: [
      { id: 1, name: 'Laborbericht 1: RLC-Schwingkreis ist fällig', activityname: 'Laborbericht 1: RLC-Schwingkreis', timesort: now + day + 5 * 3600, modulename: 'assign', cmid: 2001, courseid: 11, coursename: 'Grundlagen der Elektrotechnik II' },
      { id: 2, name: 'Hausaufgabe 4: Eigenwerte ist fällig', activityname: 'Hausaufgabe 4: Eigenwerte', timesort: now + 4 * day + 2 * 3600, modulename: 'assign', cmid: 2003, courseid: 13, coursename: 'Mathematik II – Analysis & Lineare Algebra' },
      { id: 3, name: 'Online-Test Kapitel 2 schließt', activityname: 'Online-Test Kapitel 2', timesort: now + 6 * day, modulename: 'quiz', cmid: contents[11][2].modules[2].id, courseid: 11, coursename: 'Grundlagen der Elektrotechnik II' },
      { id: 4, name: 'Projekt: Ampelsteuerung in VHDL ist fällig', activityname: 'Projekt: Ampelsteuerung in VHDL', timesort: now + 9 * day, modulename: 'assign', cmid: 2002, courseid: 12, coursename: 'Digitaltechnik' },
    ],
    grades: { 11: [
      { id: 1, name: 'Laborbericht 0: Messgeräte', itemtype: 'mod', grade: '18,00', range: '0–20', percentage: '90,00 %', feedback: '<p>Sehr saubere Messprotokolle.</p>' },
      { id: 2, name: 'Online-Test Kapitel 1', itemtype: 'mod', grade: '7,50', range: '0–10', percentage: '75,00 %' },
      { id: 3, name: 'Kursgesamt', itemtype: 'course', grade: '25,50', range: '0–30', percentage: '85,00 %' },
    ] },
    notifications: [{ id: 1, subject: 'Neue Bewertung: Online-Test Kapitel 1', time: now - 2 * day, read: false }],
    files: {}, newItems: [], notifiedEvents: [], lastSync: Date.now() - 12 * 60 * 1000,
  };
  // Dateiindex wie im echten Sync aufbauen
  const { SyncEngine } = require('../src/main/sync');
  const eng = new SyncEngine();
  eng.client = { siteUrl: SITE };
  cache.files = eng.buildFileIndex(cache, { files: {} });
  let i = 0;
  for (const f of Object.values(cache.files)) {
    if (i++ % 6 === 5 && !f.filename.startsWith('GET2_Kap2')) continue; // ein paar Dateien bleiben "online"
    fs.mkdirSync(path.dirname(f.localPath), { recursive: true });
    const body = f.filename === 'GET2_Kap2_Komplexe_Rechnung.pdf' ? pdf(SKRIPT) : f.filename.endsWith('.pdf')
      ? pdf(`${f.filename.replace('.pdf', '')}\n\nDemo-Skript (Moodle Desktop)\n\n1. Einfuehrung\nZeigerdarstellung: u(t) = U * sqrt(2) * cos(wt + phi)\nImpedanz: Z = R + j(wL - 1/(wC))\nResonanz: w0 = 1/sqrt(LC), Guete Q = (1/R) * sqrt(L/C)\nBandbreite: B = f0 / Q`)
      : Buffer.from(`// ${f.filename}\n#include <stdio.h>\nint main(void) { int x = 42; int *p = &x; printf("%d\\n", *p); return 0; }\n`);
    fs.writeFileSync(f.localPath, body);
    f.downloaded = true;
  }
  const newest = Object.values(cache.files).slice(0, 3);
  cache.newItems = newest.map((f) => ({ type: 'file', fileId: f.id, courseId: f.courseId, time: Date.now() - 40 * 60 * 1000 }));
  const p = store.file(path.join('cache', crypto.createHash('sha1').update(SITE).digest('hex').slice(0, 12) + '.json'));
  store.writeJson(p, cache);
}

async function shots() {
  const win = BrowserWindow.getAllWindows()[0];
  fs.mkdirSync(shotsDir, { recursive: true });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const run = (js) => win.webContents.executeJavaScript(js);
  const snap = async (name) => {
    await wait(700);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(shotsDir, name + '.png'), img.toPNG());
  };
  win.setSize(1440, 900);
  win.show();
  await wait(1500);
  await snap('01-dashboard');
  await run(`document.querySelector('[data-route=courses]').click()`);
  await snap('02-kurse');
  await run(`document.querySelector('[data-action=course][data-id="11"]').click()`);
  await snap('03-kurs');
  await run(`document.querySelector('[data-action=activity][data-cmid="2001"]').click()`);
  await snap('04-aufgabe');
  await run(`document.querySelector('[data-action=toggle-claude]').click()`);
  await snap('05-claude');
  await run(`document.querySelector('.crumbs [data-action=course]').click()`);
  await run(`document.querySelector('[data-action=course-tab][data-v=files]').click()`);
  await snap('06-dateien');
  await run(`document.documentElement.dataset.theme='light'; document.querySelector('[data-action=course-tab][data-v=content]').click()`);
  await snap('07-hell');
  await run(`document.querySelector('[data-route=dashboard]').click()`);
  await snap('08-dashboard-hell');
  await wait(3000); // Index im Hintergrund
  await run(`document.querySelector('#nav-q').value = 'Resonanzfrequenz'; document.querySelector('.nav-search').requestSubmit()`);
  await wait(800);
  await snap('10-suche');
  await run(`document.querySelector('.result-hit').click()`);
  await wait(2500);
  await snap('11-viewer');
  await run(`(() => { const sp = [...document.querySelectorAll('.textLayer span')].find((x) => x.textContent.includes('Resonanzfrequenz')); const r = document.createRange(); r.selectNodeContents(sp); const s = getSelection(); s.removeAllRanges(); s.addRange(r); sp.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); })()`);
  await wait(500);
  await snap('12-markiert');
  await run(`if (document.querySelector('#claude').classList.contains('closed')) document.querySelector('.claude-toggle').click(); document.querySelector('[data-action=set-provider][data-v=chatgpt]').click()`);
  await wait(800);
  await snap('13-chatgpt-panel');
  await run(`document.querySelector('[data-action=avatar], .avatar').click(); document.querySelector('[data-route=settings]').click(); document.querySelector('[data-action=settings-tab][data-v=ai]').click()`);
  await snap('14-ki-einstellungen');
  if (process.argv.includes('--chat')) {
    await run(`document.querySelector('[data-route=courses]').click(); document.querySelector('[data-action=course][data-id="11"]').click(); document.querySelector('[data-action=ask]').click()`);
    for (let i = 0; i < 90; i++) {
      await wait(2000);
      if (!(await run('document.querySelector(".typing, .step:not(.done)") !== null || document.querySelector(".send-btn[data-action=chat-stop]") !== null'))) break;
    }
    await snap('09-chat');
    console.log('CHAT:', await run(`document.querySelector('#cp-body').innerText.slice(0, 3000)`));
  }
  app.exit(0);
}

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') console.log(`[renderer ${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})`);
  });
});

app.whenReady().then(() => {
  seed();
  if (shotsDir) setTimeout(() => shots().catch((e) => { console.error(e); app.exit(1); }), 2500);
});
require('../src/main/main.js');
