// Demo-Modus mit Beispieldaten (ohne Moodle-Zugang): npm run demo
// Optional: --shots <ordner> erstellt Screenshots aller Ansichten und beendet die App,
// mit --tt zusätzlich nur den Stundenplan (Verschieben per Maus und Vorschlag per Mail),
// mit --img nur Bilder im Chat (PDF-Ausschnitt, Strg+V, „Seite erklären“ mit Seitenbild).
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

// Demo-Stundenplan: diese und nächste Woche, Mo–Fr
const DEMO_ICS = 'https://rapla.demo.invalid/tsa25.ics';
function demoIcs() {
  const mon = new Date();
  mon.setHours(0, 0, 0, 0);
  mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
  const plan = [
    [0, '09:00', '11:30', 'Mathematik II', 'D201', 'Müller, Hans'],
    [0, '12:30', '15:00', 'Elektrotechnik II', 'C107', 'Schmidt, Anna'],
    [1, '08:30', '10:45', 'Informatik II', 'B204', 'Weber, Tom'],
    [1, '11:00', '12:30', 'Physik', 'A101', 'Klein, Eva'],
    [2, '09:00', '12:15', 'Messtechnik Labor', 'Labor 3', 'Wolf, Jan'],
    [3, '13:00', '15:30', 'Mathematik II', 'D201', 'Müller, Hans'],
    [4, '09:00', '11:00', 'Projektmanagement', 'E001', 'Braun, Lea'],
  ];
  const utc = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Chadoodle Demo//DE'];
  for (let w = 0; w < 2; w++) {
    plan.forEach(([d, from, to, title, room, who], i) => {
      const at = (t) => { const x = new Date(mon); x.setDate(x.getDate() + w * 7 + d); x.setHours(...t.split(':').map(Number)); return x; };
      lines.push('BEGIN:VEVENT', `UID:demo-${w}-${i}`, `DTSTART:${utc(at(from))}`, `DTEND:${utc(at(to))}`, `SUMMARY:${title}`, `LOCATION:${room}`,
        `DESCRIPTION:Personen: ${who.replace(',', '\\,')} Ressourcen: ${room}`, 'END:VEVENT');
    });
  }
  // Eine Vorlesung läuft gerade, eine kommt heute noch (für „Jetzt im Unterricht“)
  const r5 = (ms) => new Date(Math.round(ms / 300000) * 300000);
  const live = [[-40, 50, 'Digitaltechnik (HiC)', 'B105', 'Hiller, Carl'], [100, 190, 'Programmieren in C', 'Labor 2', 'Weber, Tom']];
  live.forEach(([a, b, title, room, who], i) => {
    lines.push('BEGIN:VEVENT', `UID:demo-live-${i}`, `DTSTART:${utc(r5(Date.now() + a * 60000))}`, `DTEND:${utc(r5(Date.now() + b * 60000))}`, `SUMMARY:${title}`, `LOCATION:${room}`,
      `DESCRIPTION:Personen: ${who.replace(',', '\\,')} Ressourcen: ${room}`, 'END:VEVENT');
  });
  return lines.concat('END:VCALENDAR').join('\r\n');
}

function seed() {
  const store = require('../src/main/store');
  const { safeName } = require('../src/main/sync');
  const downloadDir = path.join(root, 'Moodle');
  store.setSettings({ siteUrl: SITE, downloadDir, syncIntervalMin: 240, notifications: false, runInBackground: false, aiProvider: 'claude' });
  store.setSecret('moodleToken', 'demo-token');
  store.setSecret('dualisUser', 'demo');
  store.setSecret('dualisPass', 'demo');
  store.setSecret('anthropicKey', 'sk-ant-demo-nur-anzeige');
  // Passkey-Zugang vortäuschen; die Prüfung beim Server beantwortet der fetch-Stub unten
  const demoUser = { name: 'Demo', isAdmin: false };
  store.setSecret('webSession', JSON.stringify({ token: 'demo', user: demoUser }));
  // Fester Stundenplan statt Rapla, damit die Demo offline gleich aussieht; Verschiebungen zurücksetzen
  store.setSettings({ timetables: [{ id: 'demo', name: 'TSA25 · Demo', url: DEMO_ICS }], timetableActive: 'demo', ttMoves: {}, ttProposalTo: '' });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    if (String(url).endsWith('/api/auth/me')) return Promise.resolve(new Response(JSON.stringify({ user: demoUser }), { headers: { 'Content-Type': 'application/json' } }));
    if (String(url).startsWith('https://dualis.dhbw.de')) return Promise.reject(new Error('Demo: Dualis nicht erreichbar'));
    if (String(url) === DEMO_ICS) return Promise.resolve(new Response(demoIcs(), { headers: { 'Content-Type': 'text/calendar' } }));
    return realFetch(url, opts);
  };

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
  // Stundenplan: Physik (Di) mit echten Mausereignissen auf Do 9:00 ziehen, Klick öffnet weiter die
  // Details, dann der Vorschlagsdialog bis zur fertigen Mail (statt des Mailprogramms wird der Link geloggt)
  const ttShots = async () => {
    const { ipcMain, clipboard } = require('electron');
    await run(`document.querySelector('[data-route=timetable]').click()`);
    await wait(1500);
    await snap('15-stundenplan');
    const pos = await run(`(() => {
      const b = [...document.querySelectorAll('button.tt-ev')].find((x) => x.textContent.includes('Physik')).getBoundingClientRect();
      const c = document.querySelectorAll('.tt-col[data-day]')[3].querySelector('.tt-body').getBoundingClientRect();
      const from = Number(document.querySelector('.tt-grid').dataset.from);
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + 12), tx: Math.round(c.left + c.width / 2), ty: Math.round(c.top + (9 - from) * 54 + 12) };
    })()`);
    const mouse = (type, x, y) => win.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1, modifiers: type === 'mouseMove' ? ['leftButtonDown'] : [] });
    mouse('mouseDown', pos.x, pos.y);
    for (let i = 1; i <= 15; i++) {
      mouse('mouseMove', Math.round(pos.x + ((pos.tx - pos.x) * i) / 15), Math.round(pos.y + ((pos.ty - pos.y) * i) / 15));
      await wait(25);
    }
    await snap('15b-ziehen');
    mouse('mouseUp', pos.tx, pos.ty);
    await wait(600);
    console.log('TT-VERSCHOBEN', await run(`JSON.stringify(Object.values(ttMoves()).map((m) => [m.title, TTP.span(m.start, m.end), TTP.span(m.newStart, m.newEnd)]))`));
    console.log('TT-DETAILS-NACH-ZIEHEN', await run(`!!document.querySelector('#modal')`));
    await snap('16-verschoben');
    // Einfacher Klick (ohne Ziehen) auf eine andere Stunde: Details gehen auf, nichts wird verschoben
    const other = await run(`(() => { const r = [...document.querySelectorAll('button.tt-ev')].find((x) => x.textContent.includes('Projektmanagement')).getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + 12) }; })()`);
    mouse('mouseDown', other.x, other.y);
    mouse('mouseUp', other.x, other.y);
    await wait(400);
    console.log('TT-KLICK-DETAILS', await run(`document.querySelector('#modal h3') && document.querySelector('#modal h3').textContent`), 'Verschiebungen:', await run('Object.keys(ttMoves()).length'));
    await run('closeModal()');
    await run(`document.querySelector('[data-action=tt-propose]').click()`);
    await wait(900);
    await run(`(() => {
      const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
      set('ttp-to', 'kurssprecher@example.org');
      set('ttp-note', 'Frau Klein ist am Dienstag auf einer Tagung, Donnerstagmorgen ist der Raum frei.');
    })()`);
    await snap('17-vorschlag-dialog');
    await run(`document.documentElement.dataset.theme = 'dark'`);
    await snap('17b-vorschlag-dunkel');
    await run(`document.documentElement.dataset.theme = 'light'`);
    // „Mail öffnen“: Link mitschreiben statt das echte Mailprogramm zu starten; Zwischenablage danach wiederherstellen
    const savedText = await clipboard.readText();
    let mailUrl = null;
    ipcMain.removeHandler('open:mail');
    ipcMain.handle('open:mail', (_e, url) => { mailUrl = url; });
    win.focus();
    await win.webContents.executeJavaScript(`document.querySelector('[data-action=tt-propose-open]').click()`, true);
    await wait(1500);
    console.log('TT-MAILTO', mailUrl ? decodeURIComponent(mailUrl) : '(nicht geöffnet)');
    const html = await win.webContents.executeJavaScript(`navigator.clipboard.read().then(async (items) => {
      const it = items.find((i) => i.types.includes('text/html'));
      return it ? (await it.getType('text/html')).text() : '';
    }).catch((e) => 'Fehler: ' + e.message)`, true);
    console.log('TT-ZWISCHENABLAGE', html.includes('NEU') ? `HTML mit Übersicht (${html.length} Zeichen)` : `(keine Übersicht) ${html.slice(0, 80)}`);
    fs.writeFileSync(path.join(shotsDir, '18-mail-uebersicht.html'), `<!doctype html><meta charset="utf-8"><body style="margin:24px">${html}</body>`);
    await snap('18-mail-fertig');
    await clipboard.writeText(savedText);
    await run('closeModal()');
  };

  // Bilder im Chat: Ausschnitt aus dem PDF mit echten Mausereignissen, Klick = ganze Seite, Esc bricht ab,
  // Strg+V mit Bild, „Seite erklären“ mit Seitenbild. Die Anfragen gehen statt an die KI an einen
  // Mitschreiber, der Typ und Größe der Bilder ausgibt.
  const imgShots = async () => {
    const { ipcMain } = require('electron');
    const mouse = (type, x, y) => win.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1, modifiers: type === 'mouseMove' ? ['leftButtonDown'] : [] });
    const sent = [];
    ipcMain.removeHandler('ai:send');
    ipcMain.handle('ai:send', (e, p) => {
      sent.push(p);
      const ev = (type, data = {}) => e.sender.send('ai:event', { conversationId: p.conversationId, type, ...data });
      ev('text-start');
      ev('text', { text: `(Demo) ${(p.images || []).length} Bild(er) erhalten.` });
      ev('done', {});
      return true;
    });
    const desc = (p) => JSON.stringify({ text: p.text.slice(0, 70), images: (p.images || []).map((i) => `${i.name} · ${i.mediaType} · ${Math.round((i.data.length * 0.75) / 1024)} KB`) });
    const imgs = () => run(`JSON.stringify(S.chat.images.map((i) => i.name + ' ' + i.w + 'x' + i.h + ' ' + i.mediaType))`);
    await run(`openDoc(Object.values(S.data.files).find((f) => f.downloaded && isPdf(f)).id)`);
    await wait(2500);
    await run(`if (document.querySelector('#claude').classList.contains('closed')) actions['toggle-claude']()`);
    await wait(500);
    await run(`document.querySelector('.vt-tools [data-action=snip-start]').click()`);
    await wait(300);
    const r = await run(`(() => { const b = V.el.querySelector('.pdf-page[data-page="1"]').getBoundingClientRect(); return { x: Math.round(b.left + b.width * 0.08), y: Math.round(b.top + b.height * 0.06), x2: Math.round(b.left + b.width * 0.9), y2: Math.round(b.top + b.height * 0.35) }; })()`);
    mouse('mouseDown', r.x, r.y);
    for (let i = 1; i <= 12; i++) {
      mouse('mouseMove', Math.round(r.x + ((r.x2 - r.x) * i) / 12), Math.round(r.y + ((r.y2 - r.y) * i) / 12));
      await wait(20);
    }
    await snap('19-ausschnitt-ziehen');
    mouse('mouseUp', r.x2, r.y2);
    await wait(1200);
    console.log('IMG-AUSSCHNITT', await imgs(), 'Ebene weg:', await run(`!document.querySelector('.snip-layer')`));
    await snap('20-ausschnitt-angehaengt');
    // Klick ohne Ziehen: ganze Seite
    await run(`startSnip(V)`);
    await wait(200);
    mouse('mouseDown', r.x + 40, r.y + 40);
    mouse('mouseUp', r.x + 40, r.y + 40);
    await wait(1200);
    console.log('IMG-KLICK-SEITE', await imgs());
    // Esc bricht ab
    await run(`startSnip(V)`);
    await wait(200);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    await wait(200);
    console.log('IMG-ESC', await run(`document.querySelector('.snip-layer') ? 'Ebene noch da' : 'abgebrochen'`), await run('S.chat.images.length'));
    // Strg+V mit einem Bild: Paste-Ereignis mit erzeugtem PNG (die echte Zwischenablage bleibt unberührt)
    await run(`(async () => {
      const c = document.createElement('canvas'); c.width = 900; c.height = 420;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 900, 420);
      g.fillStyle = '#1d1d1f'; g.font = '48px serif'; g.fillText('U = R · I,   P = U · I', 60, 140);
      g.font = '28px sans-serif'; g.fillText('Tafelbild aus der Vorlesung', 60, 220);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      const dt = new DataTransfer(); dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));
      const inp = document.querySelector('#chat-input'); inp.focus();
      inp.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    })()`);
    await wait(1200);
    console.log('IMG-EINGEFUEGT', await imgs());
    await snap('21-drei-bilder');
    await run(`document.documentElement.dataset.theme = 'dark'`);
    await snap('21b-drei-bilder-dunkel');
    await run(`document.documentElement.dataset.theme = 'light'`);
    await run(`document.querySelector('#chat-input').value = 'Was bedeutet die Formel oben?'; sendWithSelection()`);
    await wait(900);
    console.log('IMG-GESENDET', sent.length ? desc(sent[sent.length - 1]) : '(nichts)', 'Bilder danach im Feld:', await run('S.chat.images.length'));
    await snap('22-gesendet');
    await run(`document.querySelector('.msg.user .msg-img').click()`);
    await wait(500);
    await snap('23-bild-gross');
    await run('closeModal()');
    // „Diese Seite erklären“ aus dem ⋯-Menü: Seite geht als Bild mit
    await run(`document.querySelector('.vt-tools [data-action=viewer-more]').click()`);
    await wait(200);
    await run(`document.querySelector('#vmenu [data-action=viewer-ask][data-mode=page]').click()`);
    await wait(2000);
    console.log('IMG-SEITE-ERKLAEREN', sent.length > 1 ? desc(sent[sent.length - 1]) : '(nichts)');
    await snap('24-seite-erklaeren');
  };

  // Neues Design: alle Bereiche hell und dunkel, dazu Verschieben in die nächste Woche per Maus
  const designShots = async () => {
    const mouse = (type, x, y) => win.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1, modifiers: type === 'mouseMove' ? ['leftButtonDown'] : [] });
    const goTo = async (route) => { await run(`go(${JSON.stringify(route)})`); await wait(1200); };
    for (const theme of ['light', 'dark']) {
      await run(`document.documentElement.dataset.theme = '${theme}'`);
      await goTo('dashboard');
      await snap(`d-${theme}-01-uebersicht`);
      await goTo('courses');
      await snap(`d-${theme}-02-kurse`);
      await run(`go('course', { id: 11, tab: 'content' })`);
      await wait(900);
      await snap(`d-${theme}-03-kurs`);
      await goTo('timetable');
      await snap(`d-${theme}-04-stundenplan`);
      await goTo('grades');
      await wait(800);
      await snap(`d-${theme}-05-noten`);
      await goTo('mensa');
      await wait(1500);
      await snap(`d-${theme}-06-mensa`);
    }
    await run(`document.documentElement.dataset.theme = 'light'`);
    await goTo('timetable');
    // Projektmanagement (Fr) in die nächste Woche ziehen: rechts auf der Leiste verweilen, dann auf Mo 10:00
    await run(`document.querySelector('.tt-scroll').scrollTop = 7.5 * 54`);
    await wait(200);
    const p = await run(`(() => {
      const b = [...document.querySelectorAll('button.tt-ev')].find((x) => x.textContent.includes('Projektmanagement')).getBoundingClientRect();
      const rail = document.querySelector('.tt-rail').getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + 12), rx: Math.round(rail.left + rail.width / 2), ry: Math.round(b.top + 40) };
    })()`);
    mouse('mouseDown', p.x, p.y);
    for (let i = 1; i <= 12; i++) { mouse('mouseMove', Math.round(p.x + ((p.rx - p.x) * i) / 12), Math.round(p.y + ((p.ry - p.y) * i) / 12)); await wait(25); }
    await wait(300);
    await snap('d-07-ziehen-wochenrand');
    await wait(800);
    console.log('WOCHE NACH VERWEILEN', await run('ttIsoWeek(S.tt.week)'));
    const t = await run(`(() => { const c = document.querySelectorAll('.tt-col[data-day]')[0].querySelector('.tt-body').getBoundingClientRect(); return { x: Math.round(c.left + c.width / 2), y: Math.round(c.top + 10 * ${54} + 12) }; })()`);
    for (let i = 1; i <= 12; i++) { mouse('mouseMove', Math.round(p.rx + ((t.x - p.rx) * i) / 12), Math.round(p.ry + ((t.y - p.ry) * i) / 12)); await wait(25); }
    await snap('d-08-ziehen-naechste-woche');
    mouse('mouseUp', t.x, t.y);
    await wait(700);
    console.log('VERSCHOBEN', await run(`JSON.stringify(Object.values(ttMoves()).map((m) => [m.title, TTP.span(m.start, m.end), TTP.span(m.newStart, m.newEnd)]))`));
    await snap('d-09-verschoben-naechste-woche');
    // Vergangene Stunde (Mo) lässt sich nicht ziehen
    await run(`S.tt.week = ttMonday(new Date()); loadTimetable()`);
    await wait(900);
    await run(`document.querySelector('.tt-scroll').scrollTop = 7.5 * 54`);
    await wait(200);
    const old = await run(`(() => { const b = [...document.querySelectorAll('button.tt-ev')].find((x) => x.textContent.includes('Mathematik II')).getBoundingClientRect(); return { x: Math.round(b.left + 30), y: Math.round(b.top + 12) }; })()`);
    mouse('mouseDown', old.x, old.y);
    for (let i = 1; i <= 6; i++) { mouse('mouseMove', old.x + i * 20, old.y + i * 10); await wait(25); }
    mouse('mouseUp', old.x + 120, old.y + 60);
    await wait(500);
    console.log('VERGANGEN GEZOGEN, Verschiebungen:', await run('Object.keys(ttMoves()).length'));
    await snap('d-10-vergangen-gesperrt');
    // Detailfenster mit „Verschieben auf …“
    await run(`[...document.querySelectorAll('button.tt-ev')].find((x) => x.textContent.includes('Programmieren')).click()`);
    await wait(600);
    await snap('d-11-detail-verschieben');
    await run('closeModal()');
    // Schmales Fenster
    win.setSize(1024, 760);
    await goTo('dashboard');
    await snap('d-12-schmal-uebersicht');
  };

  win.setSize(1440, 900);
  win.show();
  await wait(1500);
  if (process.argv.includes('--design')) {
    await designShots();
    return app.exit(0);
  }
  if (process.argv.includes('--img')) {
    await imgShots();
    return app.exit(0);
  }
  if (process.argv.includes('--tt')) {
    await ttShots();
    return app.exit(0);
  }
  await snap('01-dashboard');
  await run(`document.querySelector('[data-route=courses]').click()`);
  await snap('02-kurse');
  await run(`document.querySelector('[data-action=course][data-id="11"]').click()`);
  await snap('03-kurs');
  await run(`document.querySelector('[data-action=activity][data-cmid="2001"]').click()`);
  await snap('04-aufgabe');
  await run(`document.querySelector('[data-action=toggle-claude]').click()`);
  await snap('05-claude');
  await run(`document.querySelector('.page-top [data-action=course]').click()`);
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
  // Strg + Mausrad über einer Stelle der Seite: Zoom um den Mauszeiger
  const box = await run(`(() => { getSelection().removeAllRanges(); ref(V, 'bubble').hidden = true; const r = V.el.querySelector('.pdf-page[data-page="4"]').getBoundingClientRect(); return { x: Math.round(r.left + r.width * 0.25), y: Math.round(r.top + 140), before: V.ctl.scale }; })()`);
  // Skala pro Frame mitschreiben: der Zoom soll gleichmäßig laufen, nicht springen
  await run(`window.__zs = []; (function rec() { __zs.push(+V.ctl.scale.toFixed(3)); if (__zs.length < 50) requestAnimationFrame(rec); })()`);
  for (let i = 0; i < 5; i++) {
    win.webContents.sendInputEvent({ type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: 120, wheelTicksY: 1, canScroll: true, modifiers: ['control'] });
    await wait(80);
  }
  await wait(900);
  console.log('ZOOM', box.before.toFixed(2), '->', (await run('V.ctl.scale')).toFixed(2), 'Label:', await run(`ref(V, 'zoom').textContent`));
  console.log('ZOOM-FRAMES', (await run('__zs')).join(' '));
  await snap('12b-zoom');
  // Tabs & Split View: zweites Dokument als Tab, daneben anzeigen, Dokumentauswahl
  await run(`openDoc(Object.values(S.data.files).find((f) => f.downloaded && isPdf(f) && f.id !== V.fileId).id)`);
  await wait(1500);
  await snap('12c-tabs');
  await run(`document.querySelector('[data-action=split-toggle]').click()`);
  await wait(1500);
  await snap('12d-split');
  // Suchleiste und ⋯-Menü in der linken Hälfte, Seiten-/Zoomleiste sichtbar
  await run(`(() => { const d = activeDoc(D.panes[0]); setPaneFocus(0); openFind(d); ref(d, 'q').value = 'Resonanz'; ref(d, 'find').requestSubmit(); showHud(d, 5000); })()`);
  await wait(900);
  await run(`document.querySelector('.vpane[data-pane="0"] [data-action=viewer-more]').click()`);
  await wait(300);
  await snap('12d2-suche-menue');
  await run(`closeMenu(); document.documentElement.dataset.theme = 'dark'`);
  await wait(300);
  await snap('12d3-split-dunkel');
  await run(`document.documentElement.dataset.theme = 'light'`);
  await run(`document.querySelector('[data-action=tab-add][data-pane="1"]').click()`);
  await wait(300);
  await snap('12e-auswahl');
  await run(`closeModal()`);
  await run(`document.querySelector('[data-action=split-close]').click()`);
  console.log('TABS nach Zusammenführen', await run(`JSON.stringify(D.panes.map((p) => p.docs.length))`));
  await run(`document.querySelector('.vtab.active [data-action=tab-close]').click()`);
  await wait(800);
  console.log('TABS nach Schließen', await run(`JSON.stringify(D.panes.map((p) => p.docs.length))`), 'aktiv:', await run('V.fileId && S.data.files[V.fileId].filename'));
  await snap('12f-ein-tab');
  // Bereich wechseln und über „Dokumente“ in der Navbar zurück zum offenen Tab
  await run(`document.querySelector('[data-route=mensa]').click()`);
  await snap('12g-mensa-mit-dokument');
  await run(`document.querySelector('#nav-docs').click()`);
  await wait(1500);
  console.log('ZURÜCK zum Dokument', await run(`S.route.name + ' ' + (V.fileId && S.data.files[V.fileId].filename) + ' S. ' + V.page`));
  await snap('12h-zurueck-im-dokument');
  await run(`if (document.querySelector('#claude').classList.contains('closed')) document.querySelector('.claude-toggle').click(); if (!document.querySelector('.cp-settings')) document.querySelector('[data-action=model-toggle]').click(); document.querySelector('[data-action=set-provider][data-v=chatgpt]').click()`);
  await wait(800);
  await snap('13-chatgpt-panel');
  await run(`document.querySelector('[data-action=avatar], .avatar').click(); document.querySelector('[data-route=settings]').click(); document.querySelector('[data-action=settings-tab][data-v=ai]').click()`);
  await snap('14-ki-einstellungen');
  await ttShots();
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
// Vor dem Start der App schreiben: Dualis liest seinen Zwischenspeicher beim Laden, und der Stundenplan
// soll frisch geladen werden (die Demo-Vorlesungen hängen von der aktuellen Uhrzeit ab)
function seedEarly() {
  const store = require('../src/main/store');
  fs.rmSync(store.file(path.join('cache', 'timetables', 'demo.json')), { force: true });
  // Noten aus Dualis (Beispiel)
  const dm = (no, name, grade, credits, status = grade ? 'bestanden' : 'offen') => ({ no, name, date: null, credits, grade, status });
  store.writeJson(store.file(path.join('cache', 'dualis.json')), { fetchedAt: Date.now() - 25 * 60 * 1000, data: {
    program: 'Elektrotechnik – Automation (Demo)',
    groups: [
      { title: 'Kernmodule', sum: { credits: 40 }, modules: [dm('T3ELG1001', 'Mathematik I', '1,7', 8), dm('T3ELG1002', 'Grundlagen der Elektrotechnik I', '2,3', 10), dm('T3ELG1003', 'Digitaltechnik', '1,3', 5), dm('T3ELG1004', 'Programmieren', '1,0', 5), dm('T3ELG1005', 'Physik', '2,0', 5), dm('T3ELG1006', 'Mathematik II', null, 7)] },
      { title: 'Schlüsselqualifikationen', sum: { credits: 5 }, modules: [dm('T3_1000', 'Wissenschaftliches Arbeiten', '1,5', 5)] },
    ],
    total: { credits: 38 }, required: 210, gpa: { total: '1,7', major: '1,8' },
  } });

}

seedEarly();
require('../src/main/main.js');
