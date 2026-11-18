// Auswertung der Dualis-Leistungsübersicht (Aufbau wie dualis.dhbw.de, Inhalte erfunden)
const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

// dualis.js lädt store.js (Electron) – für den Parser reicht ein leerer Ersatz
const origLoad = Module._load;
Module._load = function (req, parent, ...rest) {
  if (req === 'electron') return { app: { getPath: () => '.' }, safeStorage: { isEncryptionAvailable: () => false } };
  return origLoad.call(this, req, parent, ...rest);
};
const { parseResults } = require('../src/main/dualis');
Module._load = origLoad;

const row = (cls, cells) => `<tr>${cells.map((c) => (typeof c === 'string' ? `<td class="${cls}">${c}</td>` : `<td class="${cls}" colspan="${c.span}">${c.t}</td>`)).join('')}</tr>`;
const head = '<tr><td colspan="2"></td><td>Datum</td><td>Credits</td><td class="tbsubhead">Note</td><td class="tbsubhead">Status</td></tr>';
const title = (t) => `<tr><td colspan="2">${t}</td><td></td><td></td><td></td><td></td></tr>`;
const mod = (no, name, credits, grade, status) =>
  row('tbdata', [no, `${name} <!-- var PopupLink=document; --><script>open_details()</script>`, '', credits, grade, `<img src="x.gif" title="${status}" alt="${status}">`]);
const HTML = `<html><body>
<table class="nb list students_results">${head}
${title('Testing Studiengang')}${title('Module')}${title('2024 Kernmodule')}
${mod('T4ES1001', 'Mathematik I', '5,0', '1,7', 'Bestanden')}
${mod('T4ES1002', 'Elektrotechnik &amp; Messtechnik', '5,0', '1,1', 'Bestanden')}
${mod('T4ES2001', 'Mathematik III', '', '', 'Offen')}
${row('level02', [{ span: 2, t: 'Summe 2024 Kernmodule' }, '', '10,0', '', '<img title="Offen">'])}
${title('Wahlmodule')}
${row('level04', [{ span: 2, t: 'Summe Wahlmodule' }, '', '', '', '<img title="Bestanden">'])}
${row('level00', [{ span: 2, t: 'Summe Testing Studiengang' }, '', '10,0', '', '<img title="Offen">'])}
${row('level00', [{ span: 2, t: 'Erforderliche Credits für Abschluss' }, '', '210,0', '', ''])}
${row('level00', [{ span: 6, t: 'Erforderliche Credits für Abschluss: 210,0' }])}
</table>
<table class="nb list students_results"><tr><td class="tbsubhead">Gesamt-GPA</td><td class="tbsubhead">1,4</td></tr><tr><td class="tbsubhead">Hauptfach-GPA</td><td class="tbsubhead">1,3</td></tr></table>
</body></html>`;

test('Leistungsübersicht: Module, Gruppen, Summen, GPA', () => {
  const r = parseResults(HTML);
  assert.strictEqual(r.program, 'Testing Studiengang');
  assert.strictEqual(r.groups.length, 1);
  const g = r.groups[0];
  assert.strictEqual(g.title, '2024 Kernmodule');
  assert.deepStrictEqual(g.modules.map((m) => [m.no, m.name, m.credits, m.grade, m.status]), [
    ['T4ES1001', 'Mathematik I', 5, '1,7', 'Bestanden'],
    ['T4ES1002', 'Elektrotechnik & Messtechnik', 5, '1,1', 'Bestanden'],
    ['T4ES2001', 'Mathematik III', null, null, 'Offen'],
  ]);
  assert.deepStrictEqual(g.sum, { label: 'Summe 2024 Kernmodule', credits: 10, grade: null, status: 'Offen' });
  assert.strictEqual(r.total.credits, 10);
  assert.strictEqual(r.required, 210);
  assert.deepStrictEqual(r.gpa, { total: '1,4', major: '1,3' });
});

test('Unbekanntes Format wird gemeldet', () => {
  assert.throws(() => parseResults('<html>Bitte anmelden</html>'), /unbekanntes Format/);
});
