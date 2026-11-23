/* Abgeleitete Infos ohne DOM: welche Vorlesung gerade läuft, zu welchem Moodle-Kurs sie gehört und
   der genaue Notenschnitt aus Dualis. Läuft im Renderer als globales `INS` und in Node für die Tests. */
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.INS = m;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  // ---------- Laufende und nächste Vorlesung ----------
  // events: Termine mit start/end in ms. Bei Überschneidung gilt die Vorlesung, die zuerst endet.
  function lectureNow(events, now = Date.now()) {
    const timed = (events || []).filter((e) => !e.allDay);
    const running = timed.filter((e) => e.start <= now && e.end > now).sort((a, b) => a.end - b.end)[0] || null;
    const next = timed.filter((e) => e.start > now).sort((a, b) => a.start - b.start)[0] || null;
    return { running, next };
  }

  // ---------- Vorlesung → Moodle-Kurs ----------
  // Rapla-Titel („Mathematik II (HiC)“) und Moodle-Kursnamen („T3ELG1002 Mathematik II – Analysis“)
  // passen selten wörtlich. Verglichen werden die Wörter (ohne Füllwörter), Teilwörter zählen halb,
  // eine abweichende Nummer (I/II, 1/2) spricht klar dagegen.
  const STOP = new Set(['und', 'der', 'die', 'das', 'des', 'den', 'dem', 'fuer', 'mit', 'von', 'zur', 'zum', 'im', 'in', 'an', 'auf', 'am',
    'the', 'and', 'of', 'for', 'to', 'teil', 'vorlesung', 'uebung', 'labor', 'seminar', 'tutorium', 'klausur', 'pruefung', 'kurs', 'grundlagen']);
  const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
  const norm = (s) => String(s || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();

  function tokens(s) {
    const words = [];
    const nums = new Set();
    for (const t of norm(s).split(' ')) {
      if (!t) continue;
      if (ROMAN[t]) nums.add(ROMAN[t]);
      else if (/^\d{1,2}$/.test(t)) nums.add(Number(t));
      else if (/^[a-z]+\d$/.test(t) && t.length >= 4) { words.push(t.slice(0, -1)); nums.add(Number(t.slice(-1))); } // „Mathe2“
      else if (t.length >= 2 && !STOP.has(t) && !/\d{3,}/.test(t)) words.push(t);
    }
    return { words, nums };
  }

  // Titel ohne Dozentenkürzel und Zusätze in Klammern
  const cleanTitle = (t) => String(t || '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();

  function matchScore(title, course) {
    const a = tokens(cleanTitle(title));
    if (!a.words.length) return 0;
    const b = tokens(`${course.fullname || ''} ${course.shortname || ''}`);
    const set = new Set(b.words);
    let hit = 0;
    for (const w of a.words) {
      if (set.has(w)) hit += 1;
      else if (w.length >= 5 && b.words.some((c) => c.length >= 5 && (c.startsWith(w.slice(0, 6)) || w.startsWith(c.slice(0, 6))))) hit += 0.6;
    }
    let s = hit / a.words.length;
    if (a.nums.size && b.nums.size) s += [...a.nums].some((n) => b.nums.has(n)) ? 0.15 : -0.6;
    return s;
  }

  // Bester Kurs für einen Vorlesungstitel oder null. Laufende Kurse und zuletzt geöffnete gewinnen bei Gleichstand.
  function courseFor(title, courses, nowSec = Date.now() / 1000) {
    let best = null;
    let bestKey = null;
    for (const k of courses || []) {
      const s = matchScore(title, k);
      if (s < 0.6) continue;
      const running = (!k.startdate || k.startdate <= nowSec) && (!k.enddate || k.enddate >= nowSec) ? 1 : 0;
      const key = [Math.round(s * 100), running, k.lastaccess || 0];
      if (!bestKey || key[0] > bestKey[0] || (key[0] === bestKey[0] && (key[1] > bestKey[1] || (key[1] === bestKey[1] && key[2] > bestKey[2])))) {
        best = k;
        bestKey = key;
      }
    }
    return best;
  }

  // ---------- Dualis: genauer Notenschnitt ----------
  // Dualis zeigt den GPA nur mit einer Nachkommastelle. Gerechnet wird der nach Credits gewichtete
  // Schnitt aller bestandenen Module mit Note. Weil nicht sicher ist, welche Module Dualis für den
  // Hauptfach-GPA zählt, wird ein Wert nur übernommen, wenn er gerundet oder abgeschnitten zur
  // Anzeige von Dualis passt – sonst bleibt es bei der Dualis-Zahl.
  const num = (s) => {
    const n = parseFloat(String(s ?? '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  };
  function weighted(mods) {
    let sum = 0;
    let cr = 0;
    for (const m of mods) {
      const g = num(m.grade);
      const c = Number(m.credits);
      if (g == null || g < 1 || g > 4 || !(c > 0)) continue;
      sum += g * c;
      cr += c;
    }
    return cr ? sum / cr : null;
  }
  const fits = (exact, shown) => {
    if (exact == null) return false;
    if (shown == null) return true;
    const r = Math.round(exact * 10) / 10;
    const t = Math.floor(exact * 10 + 1e-9) / 10;
    return Math.abs(r - shown) < 1e-6 || Math.abs(t - shown) < 1e-6;
  };
  const MAJOR_EXCLUDE = [/schl[uü]ssel/i, /schl[uü]ssel|wahl|zusatz|studium generale/i];

  function gpaExact(data) {
    if (!data || !data.groups) return { total: null, major: null };
    const all = data.groups.flatMap((g) => g.modules.map((m) => ({ ...m, group: g.title })));
    const shownTotal = num(data.gpa && data.gpa.total);
    const shownMajor = num(data.gpa && data.gpa.major);
    const t = weighted(all);
    const total = fits(t, shownTotal) ? t : null;
    let major = null;
    if (shownMajor != null) {
      for (const re of MAJOR_EXCLUDE) {
        const m = weighted(all.filter((x) => !re.test(x.group)));
        if (fits(m, shownMajor) && m !== null) { major = m; break; }
      }
      if (major == null && fits(t, shownMajor)) major = t;
    }
    return { total, major };
  }

  const fmtGrade = (n, digits = 2) => (n == null ? null : n.toFixed(digits).replace('.', ','));

  return { lectureNow, courseFor, matchScore, gpaExact, fmtGrade, cleanTitle };
});
