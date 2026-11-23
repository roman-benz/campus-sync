// Tests für laufende Vorlesung, Kurszuordnung und genauen Notenschnitt (src/renderer/insights.js): npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const INS = require('../src/renderer/insights.js');

const courses = [
  { id: 11, fullname: 'Grundlagen der Elektrotechnik II', shortname: 'GET2' },
  { id: 12, fullname: 'Digitaltechnik', shortname: 'DT' },
  { id: 13, fullname: 'Mathematik II – Analysis & Lineare Algebra', shortname: 'MA2' },
  { id: 14, fullname: 'T3ELG1001 Mathematik I', shortname: 'MA1' },
  { id: 15, fullname: 'Programmieren in C', shortname: 'PROG-C' },
];

test('Vorlesung wird dem passenden Moodle-Kurs zugeordnet', () => {
  assert.equal(INS.courseFor('Mathematik II (HiC)', courses).id, 13);
  assert.equal(INS.courseFor('Mathematik I', courses).id, 14);
  assert.equal(INS.courseFor('Elektrotechnik II', courses).id, 11);
  assert.equal(INS.courseFor('Digitaltechnik Labor', courses).id, 12);
});

test('Ohne passenden Kurs gibt es keine Zuordnung', () => {
  assert.equal(INS.courseFor('Projektmanagement', courses), null);
  assert.equal(INS.courseFor('Physik', courses), null);
  assert.equal(INS.courseFor('', courses), null);
});

test('Laufende Vorlesung: bei Überschneidung die, die zuerst endet', () => {
  const now = 1000;
  const ev = [
    { title: 'A', start: 500, end: 2000 },
    { title: 'B', start: 900, end: 1500 },
    { title: 'C', start: 3000, end: 4000 },
    { title: 'Feiertag', start: 0, end: 5000, allDay: true },
  ];
  const r = INS.lectureNow(ev, now);
  assert.equal(r.running.title, 'B');
  assert.equal(r.next.title, 'C');
  assert.deepEqual(INS.lectureNow([], now), { running: null, next: null });
});

const dualis = (gpa, groups) => ({ gpa, groups });
const m = (name, grade, credits) => ({ no: name, name, grade, credits });

test('Notenschnitt mit zwei Nachkommastellen, gewichtet nach Credits', () => {
  const d = dualis({ total: '1,7', major: '1,7' }, [
    { title: 'Kernmodule', modules: [m('A', '1,3', 5), m('B', '2,0', 10), m('C', null, 5), m('D', 'bestanden', 5)] },
  ]);
  const g = INS.gpaExact(d);
  // (1,3·5 + 2,0·10) / 15 = 1,7666…
  assert.equal(INS.fmtGrade(g.total), '1,77');
  assert.equal(INS.fmtGrade(g.major), '1,77');
});

test('Nicht bestandene Noten zählen nicht', () => {
  const g = INS.gpaExact(dualis({ total: '1,5' }, [{ title: 'X', modules: [m('A', '1,5', 5), m('B', '5,0', 5)] }]));
  assert.equal(INS.fmtGrade(g.total), '1,50');
});

test('Hauptfach-GPA ohne Schlüsselqualifikationen, nur wenn er zu Dualis passt', () => {
  const d = dualis({ total: '1,9', major: '1,5' }, [
    { title: 'Kernmodule', modules: [m('A', '1,5', 10)] },
    { title: 'Schlüsselqualifikationen', modules: [m('S', '2,7', 5)] },
  ]);
  const g = INS.gpaExact(d);
  assert.equal(INS.fmtGrade(g.total), '1,90'); // (1,5·10 + 2,7·5) / 15
  assert.equal(INS.fmtGrade(g.major), '1,50');
});

test('Passt die Rechnung nicht zu Dualis, bleibt es bei der Dualis-Zahl', () => {
  const g = INS.gpaExact(dualis({ total: '2,5', major: '1,0' }, [{ title: 'X', modules: [m('A', '1,3', 5)] }]));
  assert.equal(g.total, null);
  assert.equal(g.major, null);
});
