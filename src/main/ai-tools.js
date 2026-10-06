// Gemeinsame Werkzeuge + Anweisungen für beide KI-Anbieter (Claude und ChatGPT).
// Alle Werkzeuge arbeiten auf der lokalen Kopie (Cache + Volltextindex).
const fs = require('fs');
const path = require('path');
const { stripHtml } = require('./extract');

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const MAX_PAGES_PER_READ = 25;

const fmtDate = (ts) =>
  ts ? new Date(ts * 1000).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–';
const fmtSize = (b) => (!b ? '' : b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.ceil(b / 1024) + ' KB');

const MOD_LABEL = {
  resource: 'Datei', folder: 'Verzeichnis', assign: 'Aufgabe', quiz: 'Test', forum: 'Forum', page: 'Textseite',
  url: 'Link', label: 'Textfeld', book: 'Buch', lesson: 'Lektion', choice: 'Abstimmung', feedback: 'Feedback',
  glossary: 'Glossar', wiki: 'Wiki', workshop: 'Gegenseitige Beurteilung', h5pactivity: 'H5P', scorm: 'SCORM',
  lti: 'Externes Tool', data: 'Datenbank', bigbluebuttonbn: 'BigBlueButton', chat: 'Chat', survey: 'Umfrage',
};

const TOOL_SPECS = [
  {
    name: 'search_documents',
    description:
      'Volltextsuche im INHALT aller synchronisierten Kursdokumente (PDF-Skripte, Folien, Word, Excel, Code). Liefert Fundstellen mit Datei, Seite und Textausschnitt. Das wichtigste Werkzeug, um Stellen in den Unterlagen zu finden. Nutze mehrere Suchen mit Synonymen/Fachbegriffen, wenn die erste wenig liefert.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Suchbegriffe; "Anführungszeichen" für exakte Wortgruppen' },
        course_id: { type: 'integer', description: 'Optional: nur in diesem Kurs suchen' },
        file_id: { type: 'string', description: 'Optional: nur in diesem Dokument suchen' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_pages',
    description: `Liest bestimmte Seiten/Folien eines Dokuments als Text (max. ${MAX_PAGES_PER_READ} Seiten pro Aufruf). Ideal nach search_documents, um eine Fundstelle mit Kontext zu lesen.`,
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string' },
        from_page: { type: 'integer', description: 'Erste Seite (ab 1)' },
        to_page: { type: 'integer', description: 'Letzte Seite (inklusive)' },
      },
      required: ['file_id', 'from_page', 'to_page'],
    },
  },
  {
    name: 'read_file',
    description: 'Liest ein ganzes Dokument (bei sehr langen Dokumenten den Anfang plus Seitenzahl). Für gezielte Stellen besser search_documents + read_pages.',
    input_schema: {
      type: 'object',
      properties: { file_id: { type: 'string', description: 'file_id aus get_course_contents, search_documents oder search_materials' } },
      required: ['file_id'],
    },
  },
  {
    name: 'list_courses',
    description: 'Listet alle Moodle-Kurse des Nutzers mit ID, Name und Fortschritt.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_course_contents',
    description: 'Struktur eines Kurses: Abschnitte mit allen Aktivitäten und Dateien inkl. file_id und module_id.',
    input_schema: {
      type: 'object',
      properties: { course_id: { type: 'integer', description: 'Kurs-ID aus list_courses' } },
      required: ['course_id'],
    },
  },
  {
    name: 'search_materials',
    description: 'Sucht in Datei-, Aktivitäts- und Abschnittsnamen sowie Textseiten, Aufgabenstellungen und Forenbeiträgen (nicht im Inhalt der PDFs – dafür search_documents).',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Suchbegriff(e)' },
        course_id: { type: 'integer', description: 'Optional: nur in diesem Kurs suchen' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_activity',
    description: 'Liest eine Aktivität: Textseite, Aufgabenstellung (mit Fälligkeit), Forendiskussionen oder Beschreibung.',
    input_schema: {
      type: 'object',
      properties: { module_id: { type: 'integer', description: 'module_id aus get_course_contents' } },
      required: ['module_id'],
    },
  },
  {
    name: 'get_deadlines',
    description: 'Anstehende Termine und Abgaben (Zeitleiste) aller Kurse.',
    input_schema: {
      type: 'object',
      properties: { days: { type: 'integer', description: 'Zeitraum in Tagen ab heute (Standard 30)' } },
      required: [],
    },
  },
  {
    name: 'get_grades',
    description: 'Bewertungen/Noten eines Kurses.',
    input_schema: { type: 'object', properties: { course_id: { type: 'integer' } }, required: ['course_id'] },
  },
];

function validateInput(name, input) {
  const tool = TOOL_SPECS.find((t) => t.name === name);
  if (!tool) return 'Unbekanntes Werkzeug';
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'Eingabe ist kein Objekt';
  for (const key of tool.input_schema.required) if (input[key] === undefined) return `Feld "${key}" fehlt`;
  for (const [key, val] of Object.entries(input)) {
    const p = tool.input_schema.properties[key];
    if (!p || val === null) continue;
    if (p.type === 'integer' && !Number.isInteger(val)) return `"${key}" muss eine ganze Zahl sein`;
    if (p.type === 'string' && typeof val !== 'string') return `"${key}" muss Text sein`;
  }
  return null;
}

function instructions(cache) {
  const site = cache && cache.site;
  const today = new Date().toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  return [
    'Du bist der Lernassistent in „Moodle Desktop“, einer Desktop-App, die die Moodle-Kurse einer/eines Studierenden lokal synchronisiert.',
    `Nutzer: ${site ? site.fullname : 'unbekannt'} (Moodle: ${site ? site.sitename : '–'}). Heute ist ${today}.`,
    '',
    'Deine Hauptaufgabe: die Kursunterlagen durchsuchen, die passenden Stellen finden und verständlich erklären.',
    '- Suche zuerst mit search_documents in den Dokumenten und lies relevante Stellen mit read_pages, bevor du inhaltlich antwortest. Rate nicht, wenn die Unterlagen die Antwort enthalten können.',
    '- Probiere bei wenigen Treffern Synonyme, Fachbegriffe, Abkürzungen oder englische Begriffe.',
    '- Belege Aussagen mit Fundstellen und verlinke sie IMMER als Markdown-Link im Format [Dateiname, S. 12](doc://FILE_ID?page=12). Die App öffnet diese Links direkt an der Seite im PDF-Viewer.',
    '- Erkläre didaktisch: erst die Kernidee, dann Details, Formeln mit LaTeX ($…$ bzw. $$…$$), bei Bedarf ein kurzes Beispiel.',
    '- Wenn die Unterlagen etwas nicht abdecken, sag das und ergänze dann mit allgemeinem Fachwissen (klar gekennzeichnet).',
    '- Für Termine, Abgaben und Noten nutze get_deadlines, read_activity und get_grades.',
    '- Bei bewerteten Abgaben: erkläre, gib Hinweise und Feedback; eine fertige Lösung zum Abgeben schreibst du nicht, sondern hilfst Schritt für Schritt.',
    '- Antworte auf Deutsch (außer der Nutzer schreibt anders) und formatiere mit Markdown.',
  ].join('\n');
}

class AiTools {
  constructor(sync, index) {
    this.sync = sync;
    this.index = index;
  }

  get cache() {
    return this.sync.cache;
  }

  findModule(cmid) {
    for (const [courseId, sections] of Object.entries(this.cache.contents)) {
      for (const s of sections) for (const m of s.modules) if (m.id === cmid) return { courseId: Number(courseId), section: s, mod: m };
    }
    return null;
  }

  describeContext(ctx) {
    if (!ctx || !this.cache) return '';
    const parts = [];
    if (ctx.courseId) {
      const k = this.cache.courses.find((c) => c.id === ctx.courseId);
      if (k) parts.push(`Der Nutzer hat den Kurs „${k.fullname}“ (course_id: ${k.id}) geöffnet.`);
    }
    if (ctx.moduleId) {
      const m = this.findModule(ctx.moduleId);
      if (m) parts.push(`Geöffnete Aktivität: ${MOD_LABEL[m.mod.modname] || m.mod.modname} „${m.mod.name}“ (module_id: ${m.mod.id}).`);
    }
    if (ctx.fileId) {
      const f = this.cache.files[ctx.fileId];
      if (f) parts.push(`Im PDF-Viewer geöffnet: „${f.filename}“ (file_id: ${f.id})${ctx.page ? `, aktuell Seite ${ctx.page}` : ''}.`);
    }
    if (ctx.selection) parts.push(`Markierter Text im Dokument:\n"""\n${String(ctx.selection).slice(0, 4000)}\n"""`);
    return parts.length ? `[Kontext: ${parts.join(' ')}]` : '';
  }

  label(name, input) {
    const f = input && input.file_id && this.cache.files[input.file_id];
    const k = input && input.course_id && this.cache.courses.find((c) => c.id === input.course_id);
    switch (name) {
      case 'search_documents': return `Durchsucht Dokumente nach „${input.query}“`;
      case 'read_pages': return `Liest ${f ? f.filename : 'Dokument'}, S. ${input.from_page}${input.to_page > input.from_page ? '–' + input.to_page : ''}`;
      case 'read_file': return `Liest ${f ? f.filename : 'Datei'}`;
      case 'list_courses': return 'Schaut sich deine Kurse an';
      case 'get_course_contents': return `Öffnet Kurs ${k ? k.shortname || k.fullname : ''}`;
      case 'search_materials': return `Sucht Materialien zu „${input.query}“`;
      case 'read_activity': { const m = this.findModule(input.module_id); return `Liest ${m ? m.mod.name : 'Aktivität'}`; }
      case 'get_deadlines': return 'Prüft anstehende Termine';
      case 'get_grades': return `Prüft Bewertungen ${k ? k.shortname || k.fullname : ''}`;
      default: return name;
    }
  }

  // Liefert einen String oder (nur für Claude) Content-Blöcke
  async run(name, input, provider) {
    const c = this.cache;
    if (!c || !c.site) return 'Noch keine Daten synchronisiert.';
    switch (name) {
      case 'search_documents': {
        const r = this.index.search(input.query, { courseId: input.course_id || null, fileId: input.file_id || null, limit: 25 });
        const st = this.index.status();
        const note = st.indexed < st.total ? `\n(Hinweis: ${st.indexed} von ${st.total} Dokumenten sind bereits indexiert.)` : '';
        if (!r.hits.length) return `Keine Fundstellen für „${input.query}“.${note}`;
        const lines = [`${r.totalPages} Seiten in ${r.totalFiles} Dokumenten gefunden (beste Treffer):`];
        for (const h of r.hits) {
          const f = c.files[h.fileId];
          const k = c.courses.find((x) => x.id === f.courseId);
          lines.push(`- ${f.filename} [${k ? k.shortname : ''}] (file_id: ${f.id}) S. ${h.page}: ${h.snippet}`);
        }
        return lines.join('\n') + note;
      }

      case 'read_pages': {
        const from = Math.max(1, input.from_page);
        const to = Math.min(input.to_page, from + MAX_PAGES_PER_READ - 1);
        const f = c.files[input.file_id];
        const r = await this.index.getPages(input.file_id, from, Math.max(from, to));
        const head = `${f.filename} – Seiten ${r.pages[0] ? r.pages[0].n : from}–${r.pages.length ? r.pages[r.pages.length - 1].n : to} von ${r.total}`;
        return [head, ...r.pages.map((p) => `\n--- Seite ${p.n} ---\n${p.text || '(kein Text – evtl. nur Abbildung)'}`)].join('\n');
      }

      case 'read_file': {
        const f = c.files[input.file_id];
        if (!f) throw new Error('Unbekannte file_id');
        await this.sync.ensureFile(f.id);
        const ext = path.extname(f.filename).toLowerCase();
        const size = fs.statSync(f.localPath).size;
        if (provider === 'claude' && ext === '.pdf' && size <= 30 * 1024 * 1024) {
          const d = await this.index.ensureIndexed(f).catch(() => null);
          if (!d || d.pages.length <= 100) {
            return [{ type: 'document', title: f.filename, source: { type: 'base64', media_type: 'application/pdf', data: fs.readFileSync(f.localPath).toString('base64') } }];
          }
        }
        if (IMAGE_TYPES[ext]) {
          if (provider !== 'claude') return 'Bilddateien kann ich in diesem Modus nicht ansehen.';
          if (size > 5 * 1024 * 1024) throw new Error('Bild ist zu groß (max. 5 MB).');
          return [{ type: 'image', source: { type: 'base64', media_type: IMAGE_TYPES[ext], data: fs.readFileSync(f.localPath).toString('base64') } }];
        }
        const r = await this.index.getPages(f.id, 1, 40);
        const more = r.total > 40 ? `\n\n[Dokument hat ${r.total} Seiten – weitere Seiten mit read_pages lesen.]` : '';
        return `${f.filename} (${r.total} Seiten)\n` + r.pages.map((p) => `\n--- Seite ${p.n} ---\n${p.text}`).join('\n') + more;
      }

      case 'list_courses':
        return c.courses
          .map((k) => `- ${k.fullname} (course_id: ${k.id}, Kürzel: ${k.shortname}${k.categoryname ? ', ' + k.categoryname : ''}${k.progress != null ? `, Fortschritt ${Math.round(k.progress)}%` : ''})`)
          .join('\n') || 'Keine Kurse.';

      case 'get_course_contents': {
        const k = c.courses.find((x) => x.id === input.course_id);
        if (!k) throw new Error('Kurs nicht gefunden');
        const lines = [`# ${k.fullname}`];
        for (const s of c.contents[k.id] || []) {
          lines.push(`\n## ${s.name || 'Abschnitt ' + s.section}`);
          const sum = stripHtml(s.summary);
          if (sum) lines.push(sum.slice(0, 600));
          for (const m of s.modules) {
            let line = `- [${MOD_LABEL[m.modname] || m.modname}] ${m.name} (module_id: ${m.id})`;
            const a = c.assignments[m.id];
            if (a && a.duedate) line += ` – fällig ${fmtDate(a.duedate)}`;
            lines.push(line);
            if (m.modname === 'label') {
              const t = stripHtml(m.description);
              if (t) lines.push('  ' + t.slice(0, 300).replace(/\n/g, ' '));
            }
            const files = (m.contents || []).filter((f) => f.id).concat(a ? a.attachments.filter((f) => f.id) : []);
            for (const f of files) {
              const lf = c.files[f.id];
              lines.push(`  - Datei: ${f.filename} (file_id: ${f.id}, ${fmtSize(f.filesize)}${lf && lf.downloaded ? ', lokal' : ''})`);
            }
          }
        }
        return lines.join('\n');
      }

      case 'search_materials': {
        const terms = input.query.toLowerCase().split(/\s+/).filter(Boolean);
        const score = (txt) => {
          const t = String(txt || '').toLowerCase();
          return terms.reduce((s, w) => s + (t.includes(w) ? 1 : 0), 0);
        };
        const hits = [];
        for (const k of c.courses) {
          if (input.course_id && k.id !== input.course_id) continue;
          for (const s of c.contents[k.id] || []) {
            for (const m of s.modules) {
              const extra = stripHtml(m.description) + ' ' + stripHtml(c.pages[m.id] && c.pages[m.id].content) + ' ' + stripHtml(c.assignments[m.id] && c.assignments[m.id].intro);
              const sc = score(m.name) * 3 + score(s.name) + score(extra);
              if (sc) hits.push({ sc, text: `[${k.shortname}] ${MOD_LABEL[m.modname] || m.modname} „${m.name}“ in „${s.name}“ (module_id: ${m.id})` });
            }
          }
          for (const f of Object.values(c.files)) {
            if (f.courseId !== k.id) continue;
            const sc = score(f.filename) * 3 + score(f.moduleName);
            if (sc) hits.push({ sc, text: `[${k.shortname}] Datei ${f.filename} (file_id: ${f.id}, Aktivität „${f.moduleName}“)` });
          }
        }
        for (const [cmid, fo] of Object.entries(c.forums)) {
          if (input.course_id && fo.courseid !== input.course_id) continue;
          for (const d of fo.discussions) {
            const sc = score(d.subject) * 2 + score(stripHtml(d.message));
            if (sc) hits.push({ sc, text: `Forum „${fo.name}“: ${d.subject} (module_id: ${cmid}, ${fmtDate(d.modified)})` });
          }
        }
        hits.sort((a, b) => b.sc - a.sc);
        return hits.length ? hits.slice(0, 40).map((h) => '- ' + h.text).join('\n') : 'Keine Treffer.';
      }

      case 'read_activity': {
        const hit = this.findModule(input.module_id);
        if (!hit) throw new Error('Aktivität nicht gefunden');
        const m = hit.mod;
        const out = [`${MOD_LABEL[m.modname] || m.modname}: ${m.name}`];
        if (m.dates && m.dates.length) out.push(m.dates.map((d) => `${d.label} ${fmtDate(d.timestamp)}`).join(' · '));
        const a = c.assignments[m.id];
        if (a) {
          out.push(`Fällig: ${fmtDate(a.duedate)}${a.cutoffdate ? ` · Letzte Abgabemöglichkeit: ${fmtDate(a.cutoffdate)}` : ''}`);
          out.push(stripHtml(a.intro));
          if (a.attachments.length) out.push('Anhänge: ' + a.attachments.map((f) => `${f.filename} (file_id: ${f.id})`).join(', '));
        }
        const p = c.pages[m.id];
        if (p) out.push(stripHtml(p.content));
        const fo = c.forums[m.id];
        if (fo) for (const d of fo.discussions) out.push(`\n### ${d.subject}\nvon ${d.author}, ${fmtDate(d.created)}\n${stripHtml(d.message)}`);
        if (!a && !p && !fo) out.push(stripHtml(m.description) || '(Keine Beschreibung. Diese Aktivität ist nur online in Moodle verfügbar.)');
        if (m.url) out.push(`Online: ${m.url}`);
        return out.filter(Boolean).join('\n');
      }

      case 'get_deadlines': {
        const until = Date.now() / 1000 + (input.days || 30) * 86400;
        const list = c.events.filter((e) => e.timesort <= until);
        if (!list.length) return 'Keine anstehenden Termine in diesem Zeitraum.';
        return list
          .map((e) => `- ${fmtDate(e.timesort)}: ${e.activityname || e.name} (${e.coursename})${e.overdue ? ' – ÜBERFÄLLIG' : ''}${e.cmid ? ` (module_id: ${e.cmid})` : ''}`)
          .join('\n');
      }

      case 'get_grades': {
        const g = c.grades[input.course_id];
        if (!g || !g.length) return 'Keine Bewertungen vorhanden.';
        return g
          .map((it) => `- ${stripHtml(it.name)}: ${it.grade || '–'}${it.range ? ` (Bereich ${it.range})` : ''}${it.percentage && it.percentage !== '-' ? `, ${it.percentage}` : ''}${it.feedback ? ` – Feedback: ${stripHtml(it.feedback)}` : ''}`)
          .join('\n');
      }
    }
    throw new Error('Unbekanntes Werkzeug');
  }

  // Angehängte Dateien als Inhalt für die erste Nachricht
  async attachmentBlocks(fileIds, provider) {
    const blocks = [];
    for (const id of fileIds) {
      const f = this.cache.files[id];
      if (!f) continue;
      try {
        const out = await this.run('read_file', { file_id: id }, provider);
        blocks.push({ type: 'text', text: `Angehängte Datei: ${f.filename} (file_id: ${f.id})` });
        if (typeof out === 'string') blocks.push({ type: 'text', text: out });
        else blocks.push(...out);
      } catch (e) {
        blocks.push({ type: 'text', text: `Angehängte Datei ${f.filename} konnte nicht gelesen werden: ${e.message}` });
      }
    }
    return blocks;
  }
}

module.exports = { AiTools, TOOL_SPECS, validateInput, instructions };
