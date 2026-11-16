// Tests für die Verschiebevorschläge im Stundenplan (src/renderer/tt-proposal.js): npm test
process.env.TZ = 'Europe/Berlin';
const test = require('node:test');
const assert = require('node:assert/strict');
const TTP = require('../src/renderer/tt-proposal.js');

const MIN = 60000;
const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const day = (y, mo, d) => new Date(y, mo - 1, d).getTime();

// Mathe am Mittwoch 18.11.2026 9:00–11:30 auf Freitag 13:00–15:30
const mathe = {
  id: 'mathe@1', title: 'Mathematik II', location: 'D201',
  start: at(2026, 11, 18, 9), end: at(2026, 11, 18, 11, 30),
  newStart: at(2026, 11, 20, 13), newEnd: at(2026, 11, 20, 15, 30),
};

test('dropStart rastert auf 15 Minuten', () => {
  const base = { day: day(2026, 11, 18), fromHour: 8, toHour: 18, hourPx: 54, duration: 90 * MIN };
  // 1 h 07 min unter 8:00 → 9:00 (näher an 9:00 als an 9:15)
  assert.equal(TTP.dropStart({ ...base, y: (67 / 60) * 54 }), at(2026, 11, 18, 9));
  // 1 h 08 min → 9:15
  assert.equal(TTP.dropStart({ ...base, y: (68 / 60) * 54 }), at(2026, 11, 18, 9, 15));
});

test('dropStart hält den Termin im sichtbaren Bereich', () => {
  const base = { day: day(2026, 11, 18), fromHour: 8, toHour: 18, hourPx: 54, duration: 120 * MIN };
  assert.equal(TTP.dropStart({ ...base, y: -200 }), at(2026, 11, 18, 8));
  // Ende darf nicht hinter 18:00 liegen → spätestens 16:00
  assert.equal(TTP.dropStart({ ...base, y: 5000 }), at(2026, 11, 18, 16));
});

test('dropStart am Tag der Zeitumstellung', () => {
  // 25.10.2026: Ende der Sommerzeit. Gerechnet wird wie in der Ansicht in Minuten ab Mitternacht.
  const d = day(2026, 10, 25);
  const s = TTP.dropStart({ day: d, fromHour: 8, toHour: 18, hourPx: 54, duration: 60 * MIN, y: 54 });
  assert.equal(s - d, 9 * 60 * MIN);
});

test('Betreff nennt Plan und Kalenderwoche', () => {
  assert.equal(TTP.subject('TSA25', [mathe]), 'Verschiebevorschlag Stundenplan TSA25 (KW 47)');
});

test('Mailtext enthält alte und neue Zeit, Bemerkung und Absender', () => {
  const text = TTP.mailText({ planName: 'TSA25', moves: [mathe], note: 'Dozent ist am Dienstag krank.', sender: 'Julia Muster' });
  assert.match(text, /folgende Verschiebung im Stundenplan TSA25/);
  assert.match(text, /• Mathematik II \(D201\)/);
  assert.match(text, /bisher: Mi, 18\.11\., 09:00–11:30/);
  assert.match(text, /neu: {4}Fr, 20\.11\., 13:00–15:30/);
  assert.match(text, /Bemerkung:\nDozent ist am Dienstag krank\./);
  assert.match(text, /Viele Grüße\nJulia Muster$/);
});

test('Mailtext ohne Bemerkung hat keinen leeren Abschnitt', () => {
  assert.doesNotMatch(TTP.mailText({ planName: 'TSA25', moves: [mathe], note: '   ' }), /Bemerkung/);
});

test('mailto-Link: Empfänger, Betreff und Text richtig kodiert', () => {
  const m = TTP.buildMail({ to: 'kurs.sprecher@example.org', planName: 'TSA25', moves: [mathe], note: 'A & B?', sender: 'J' });
  assert.equal(m.shortened, false);
  assert.ok(m.url.startsWith('mailto:kurs.sprecher@example.org?subject='));
  const u = new URL(m.url);
  assert.equal(u.searchParams.get('subject'), 'Verschiebevorschlag Stundenplan TSA25 (KW 47)');
  // Zeilenumbrüche als CRLF (RFC 6068), Sonderzeichen überstehen die Kodierung
  assert.equal(u.searchParams.get('body'), m.text.replace(/\n/g, '\r\n'));
  assert.match(u.searchParams.get('body'), /A & B\?/);
});

test('Zu langer mailto-Link wird gekürzt, Liste kommt über die Zwischenablage', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ ...mathe, id: `m${i}`, title: `Veranstaltung mit langem Namen Nr. ${i}` }));
  const m = TTP.buildMail({ to: 'a@b.de', planName: 'TSA25', moves: many, note: 'x'.repeat(500) });
  assert.equal(m.shortened, true);
  assert.ok(m.url.length <= TTP.MAILTO_MAX);
  assert.match(decodeURIComponent(m.url), /Strg\+V/);
});

test('E-Mail-Adressen prüfen', () => {
  assert.ok(TTP.validEmail('kurssprecher@dhbw-ravensburg.de'));
  assert.ok(!TTP.validEmail('kein-at.de'));
  assert.ok(!TTP.validEmail('a@b.de?cc=fremd@x.de'));
  assert.ok(!TTP.validEmail(''));
});

test('Übersicht: alte und neue Zeit, unveränderte Termine, HTML wird maskiert', () => {
  const context = [
    { id: 'phys@1', title: 'Physik <script>', location: 'A101', start: at(2026, 11, 20, 9), end: at(2026, 11, 20, 10, 30) },
    { id: 'mathe@1', title: 'Mathematik II', start: mathe.start, end: mathe.end }, // der verschobene selbst: nicht doppelt
    { id: 'anderer-tag', title: 'Montag', start: at(2026, 11, 16, 9), end: at(2026, 11, 16, 10) }, // Tag ohne Änderung: weglassen
  ];
  const html = TTP.overviewHtml({ planName: 'TSA25', moves: [mathe], context });
  assert.match(html, /KW 47/);
  assert.match(html, /Mi, 18\.11\./);
  assert.match(html, /Fr, 20\.11\./);
  assert.doesNotMatch(html, /Mo, 16\.11\./);
  assert.match(html, /NEU<\/b> <b>Mathematik II<\/b><br>13:00–15:30/);
  assert.match(html, /BISHER<\/b> <s>Mathematik II<\/s><br>09:00–11:30/);
  assert.match(html, /Physik &lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  // 2,5 Stunden = 10 Viertelstunden-Zeilen
  assert.match(html, /rowspan="10"[^>]*>(<b style="color:#2b8a3e">)?NEU/);
  assert.equal((html.match(/Mathematik II/g) || []).length, 2);
});

test('Übersicht mit Liste und Bemerkung für gekürzte Mails', () => {
  const html = TTP.overviewHtml({ planName: 'TSA25', moves: [mathe], note: 'Bitte <b>prüfen</b>', withText: true });
  assert.match(html, /bisher: Mi, 18\.11\., 09:00–11:30/);
  assert.match(html, /Bitte &lt;b&gt;prüfen&lt;\/b&gt;/);
});

test('Verschiebung am selben Tag: alt und neu nebeneinander in zwei Spuren', () => {
  const m = { ...mathe, newStart: at(2026, 11, 18, 10), newEnd: at(2026, 11, 18, 12, 30) };
  const html = TTP.overviewHtml({ planName: 'TSA25', moves: [m] });
  assert.match(html, /colspan="2"[^>]*>Mi, 18\.11\./);
});
