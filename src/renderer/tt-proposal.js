/* Stundenplan: Verschiebevorschläge – reine Logik ohne DOM.
   Rasterung beim Ziehen, Betreff und Text der Mail, mailto-Link und die Übersicht als HTML-Tabelle
   (Mailprogramme können kein modernes CSS, kein SVG und kein JavaScript – Tabellen mit Inline-Styles
   sehen in Outlook, Gmail und Apple Mail gleich aus).
   Läuft im Renderer als globales `TTP` und in Node für die Tests (npm test). */
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.TTP = m;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const MIN = 60000;
  const STEP_MIN = 15;
  // Längere mailto-Links schneiden manche Mailprogramme (z. B. Outlook) ab
  const MAILTO_MAX = 2000;
  const SLOT_PX = 10; // Höhe einer Viertelstunde in der Mail-Übersicht

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const pad = (n) => String(n).padStart(2, '0');
  const midnight = (ms) => new Date(ms).setHours(0, 0, 0, 0);
  const minutesOf = (ms) => (ms - midnight(ms)) / MIN;
  const clock = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  const dayLabel = (ms) => { const d = new Date(ms); return `${WD[d.getDay()]}, ${pad(d.getDate())}.${pad(d.getMonth() + 1)}.`; };
  const span = (start, end) => `${dayLabel(start)}, ${clock(start)}–${clock(end)}`;
  const sorted = (moves) => [...moves].sort((a, b) => a.start - b.start);

  function isoWeek(ms) {
    const d = new Date(ms);
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
    return Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
  }
  function monday(ms) {
    const d = new Date(midnight(ms));
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d.getTime();
  }

  // Neuer Beginn aus der Position im Raster: auf 15 Minuten gerastert und so begrenzt, dass der
  // Termin ganz im sichtbaren Bereich (fromHour–toHour) bleibt. y = Oberkante des Termins in px
  // ab dem Rasterbeginn, day = Mitternacht des Zieltags. Gerechnet wird wie in der Ansicht in
  // Minuten ab Mitternacht, damit die Zeitumstellung nichts verschiebt.
  function dropStart({ day, fromHour, toHour, y, hourPx, duration }) {
    const raw = fromHour * 60 + (y / hourPx) * 60;
    const snapped = Math.round(raw / STEP_MIN) * STEP_MIN;
    const lo = fromHour * 60;
    const hi = Math.max(lo, toHour * 60 - duration / MIN);
    return day + Math.min(hi, Math.max(lo, snapped)) * MIN;
  }

  const validEmail = (s) => /^[^\s@<>()",;:?&]+@[^\s@<>()",;:?&]+\.[^\s@<>()",;:?&]+$/.test(String(s || '').trim());

  function subject(planName, moves) {
    const weeks = [...new Set(sorted(moves).map((m) => isoWeek(m.start)))];
    return `Verschiebevorschlag Stundenplan ${planName}${weeks.length ? ` (KW ${weeks.join(', ')})` : ''}`;
  }

  // Text der Mail. Mit full = false nur Anrede und Hinweis (für zu lange mailto-Links)
  function mailText({ planName, moves, note, sender, full = true }) {
    const list = sorted(moves);
    const lines = ['Hallo,', '', `ich schlage ${list.length === 1 ? 'folgende Verschiebung' : 'folgende Verschiebungen'} im Stundenplan ${planName} vor:`, ''];
    if (full) {
      for (const m of list) {
        lines.push(`• ${m.title}${m.location ? ` (${m.location})` : ''}`);
        lines.push(`  bisher: ${span(m.start, m.end)}`);
        lines.push(`  neu:    ${span(m.newStart, m.newEnd)}`);
        lines.push('');
      }
      const n = String(note || '').trim();
      if (n) lines.push('Bemerkung:', n, '');
    } else {
      lines.push('[Hier mit Strg+V die Übersicht einfügen – sie liegt in der Zwischenablage.]', '');
    }
    lines.push('Viele Grüße');
    if (sender) lines.push(sender);
    return lines.join('\n');
  }

  function mailtoUrl({ to, subject: subj, body }) {
    const addr = encodeURIComponent(String(to || '').trim()).replace(/%40/g, '@');
    return `mailto:${addr}?subject=${encodeURIComponent(subj)}&body=${encodeURIComponent(String(body).replace(/\r?\n/g, '\r\n'))}`;
  }

  // Fertige Mail: mailto-Link mit vollem Text, bei zu vielen Änderungen eine Kurzfassung.
  // shortened = true heißt: Liste und Bemerkung müssen per Zwischenablage (HTML) in die Mail.
  function buildMail({ to, planName, moves, note, sender }) {
    const subj = subject(planName, moves);
    const text = mailText({ planName, moves, note, sender });
    const url = mailtoUrl({ to, subject: subj, body: text });
    if (url.length <= MAILTO_MAX) return { subject: subj, text, url, shortened: false };
    const short = mailText({ planName, moves, note, sender, full: false });
    return { subject: subj, text, url: mailtoUrl({ to, subject: subj, body: short }), shortened: true };
  }

  // ---------- Übersicht als HTML (für die Mail und die Vorschau im Dialog) ----------
  const STYLE = {
    neu: 'background:#e3f3e7;border-left:3px solid #2b8a3e;color:#1d1d1f;',
    bisher: 'background:#ffffff;border:1px dashed #a1a1a6;color:#8a8a8e;',
    ctx: 'background:#f2f2f5;border-left:3px solid #c7c7cc;color:#6c6c71;',
  };

  // Spuren je Tag: überlappende Termine nebeneinander (alt/neu desselben Termins inklusive)
  function lanes(items) {
    const ends = [];
    for (const it of [...items].sort((a, b) => a.start - b.start || b.end - a.end)) {
      let lane = ends.findIndex((e) => e <= it.start);
      if (lane < 0) lane = ends.length;
      ends[lane] = it.end;
      it.lane = lane;
    }
    return Math.max(1, ends.length);
  }

  function weekTable(days) {
    const all = days.flatMap((d) => d.items);
    const from = Math.max(6 * 60, Math.floor(Math.min(...all.map((i) => minutesOf(i.start))) / 60) * 60);
    const to = Math.min(24 * 60, Math.ceil(Math.max(...all.map((i) => minutesOf(i.start) + (i.end - i.start) / MIN)) / 60) * 60);
    const rows = Math.max(4, (to - from) / STEP_MIN);
    const slot = (ms) => Math.round((minutesOf(ms) - from) / STEP_MIN);
    const dayW = 92 / days.length;

    // Belegung je Tag und Spur: Startzeile → Termin, belegte Zeilen merken
    const cols = [];
    for (const d of days) {
      const n = lanes(d.items);
      for (let l = 0; l < n; l++) {
        const starts = new Map();
        const covered = new Set();
        for (const it of d.items.filter((x) => x.lane === l)) {
          const a = Math.max(0, slot(it.start));
          const b = Math.min(rows, Math.max(a + 1, slot(it.end)));
          starts.set(a, { it, span: b - a });
          for (let r = a + 1; r < b; r++) covered.add(r);
        }
        cols.push({ starts, covered, first: l === 0, width: dayW / n });
      }
      d.lanes = n;
    }

    const sizing = `<tr><td style="width:8%;height:0;line-height:0;font-size:0;padding:0"></td>${cols.map((c) => `<td style="width:${c.width.toFixed(2)}%;height:0;line-height:0;font-size:0;padding:0"></td>`).join('')}</tr>`;
    const head = `<tr><td></td>${days.map((d) => `<td colspan="${d.lanes}" style="padding:4px 6px 6px;font-size:12px;font-weight:600;color:#1d1d1f;border-left:1px solid #e5e5ea;border-bottom:1px solid #e5e5ea">${esc(dayLabel(d.day))}</td>`).join('')}</tr>`;
    const body = [];
    for (let r = 0; r < rows; r++) {
      const hourLine = (from + r * STEP_MIN) % 60 === 0;
      let tr = `<tr style="height:${SLOT_PX}px">`;
      if (r % 4 === 0) {
        tr += `<td rowspan="${Math.min(4, rows - r)}" style="vertical-align:top;text-align:right;padding:0 6px 0 0;font-size:10px;line-height:12px;color:#8a8a8e;border-top:1px solid #e5e5ea">${pad(Math.floor((from + r * STEP_MIN) / 60))}:00</td>`;
      }
      for (const c of cols) {
        const s = c.starts.get(r);
        const left = c.first ? 'border-left:1px solid #e5e5ea;' : '';
        if (s) {
          const { it } = s;
          const label = it.kind === 'neu' ? '<b style="color:#2b8a3e">NEU</b> ' : it.kind === 'bisher' ? '<b>BISHER</b> ' : '';
          const title = it.kind === 'bisher' ? `<s>${esc(it.title)}</s>` : `<b>${esc(it.title)}</b>`;
          tr += `<td rowspan="${s.span}" style="${STYLE[it.kind]}vertical-align:top;padding:3px 5px;font-size:11px;line-height:13px;border-top:2px solid #ffffff;border-bottom:1px solid #ffffff">${label}${title}<br>${clock(it.start)}–${clock(it.end)}${it.location ? ` · ${esc(it.location)}` : ''}</td>`;
        } else if (!c.covered.has(r)) {
          tr += `<td style="height:${SLOT_PX}px;line-height:0;font-size:0;padding:0;${left}${hourLine ? 'border-top:1px solid #eeeef2;' : ''}">&nbsp;</td>`;
        }
      }
      body.push(tr + '</tr>');
    }
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;width:100%;max-width:680px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;background:#ffffff">${sizing}${head}${body.join('')}</table>`;
  }

  // Übersicht: je betroffener Woche die Tage mit Änderungen, darauf unveränderte Termine (grau),
  // die bisherige Zeit (gestrichelt) und die neue Zeit (grün). Mit withText kommen Liste und
  // Bemerkung dazu (wenn der mailto-Link dafür zu lang war).
  function overviewHtml({ planName, moves, context = [], note, withText = false }) {
    const list = sorted(moves);
    const days = new Map();
    const add = (it) => {
      const d = midnight(it.start);
      if (!days.has(d)) days.set(d, { day: d, items: [] });
      days.get(d).items.push(it);
    };
    for (const m of list) {
      add({ kind: 'bisher', title: m.title, location: m.location, start: m.start, end: m.end });
      add({ kind: 'neu', title: m.title, location: m.location, start: m.newStart, end: m.newEnd });
    }
    const moved = new Set(list.map((m) => m.id));
    for (const e of context) {
      if (moved.has(e.id) || e.allDay || !days.has(midnight(e.start))) continue;
      days.get(midnight(e.start)).items.push({ kind: 'ctx', title: e.title, location: e.location, start: e.start, end: e.end });
    }
    const weeks = new Map();
    for (const d of [...days.values()].sort((a, b) => a.day - b.day)) {
      const w = monday(d.day);
      if (!weeks.has(w)) weeks.set(w, []);
      weeks.get(w).push(d);
    }
    const font = "font-family:'Segoe UI',Helvetica,Arial,sans-serif;";
    const parts = [];
    for (const [w, ds] of weeks) {
      parts.push(`<p style="${font}margin:16px 0 6px;font-size:14px;font-weight:600;color:#1d1d1f">Stundenplan ${esc(planName)} · KW ${isoWeek(w)}</p>`);
      parts.push(weekTable(ds));
    }
    const box = (style) => `<span style="display:inline-block;width:10px;height:10px;vertical-align:-1px;margin:0 4px 0 12px;${style}"></span>`;
    parts.push(`<p style="${font}margin:8px 0 0;font-size:11px;color:#6c6c71">${box(STYLE.neu)}neu${box(STYLE.bisher)}bisher${box(STYLE.ctx)}unverändert</p>`);
    if (withText) {
      parts.push(`<ul style="${font}font-size:13px;color:#1d1d1f;padding-left:18px">${list.map((m) => `<li style="margin-bottom:6px"><b>${esc(m.title)}</b>${m.location ? ` (${esc(m.location)})` : ''}<br>bisher: ${esc(span(m.start, m.end))}<br>neu: ${esc(span(m.newStart, m.newEnd))}</li>`).join('')}</ul>`);
      const n = String(note || '').trim();
      if (n) parts.push(`<p style="${font}font-size:13px;color:#1d1d1f;white-space:pre-wrap"><b>Bemerkung:</b><br>${esc(n)}</p>`);
    }
    return parts.join('');
  }

  return { STEP_MIN, MAILTO_MAX, dropStart, validEmail, subject, mailText, mailtoUrl, buildMail, overviewHtml, span, isoWeek };
});
