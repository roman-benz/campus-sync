// Gemeinsame Werkzeuge + Anweisungen für beide KI-Anbieter (Claude und ChatGPT).
// Alle Werkzeuge arbeiten auf der lokalen Kopie (Cache + Volltextindex).
// Datenschutz: Die Moodle-Nutzungsvereinbarung untersagt, Daten anderer an Dritte weiterzugeben.
// Deshalb gehen keine Namen anderer Personen (Forenautoren) an den KI-Anbieter, und Noten nur
// mit ausdrücklicher Zustimmung in den Einstellungen (aiGrades).
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { stripHtml } = require('./extract');

const gradesAllowed = () => !!store.getSettings().aiGrades;

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
  {
    name: 'get_timetable',
    description: 'Vorlesungen aus dem aktiven Stundenplan (Rapla/iCal) mit Uhrzeit, Titel und Raum, nach Tagen gruppiert.',
    input_schema: {
      type: 'object',
      properties: {
        from_date: { type: 'string', description: 'Erster Tag als YYYY-MM-DD (Standard: heute)' },
        days: { type: 'integer', description: 'Anzahl Tage ab from_date, 1–21 (Standard 7)' },
      },
      required: [],
    },
  },
  {
    name: 'get_mensa_menu',
    description:
      'Speiseplan der Mensa mit dish_id, Kategorie, Beschreibung, vegan/vegetarisch, Allergenen und Preisen. Für vorbestellbare Tage zusätzlich freie Abholzeiten und Restmengen sowie bereits aufgegebene Bestellungen.',
    input_schema: {
      type: 'object',
      properties: { date: { type: 'string', description: 'Optional: nur dieser Tag (YYYY-MM-DD); sonst alle veröffentlichten Tage' } },
      required: [],
    },
  },
  {
    name: 'prepare_mensa_cart',
    description:
      'Legt Gerichte für einen Tag in den Mensa-Warenkorb der App (ersetzt den bisherigen Warenkorb dieses Tages) und wählt optional die Abholzeit. Bestellt NICHT – abschicken muss der Nutzer selbst im Reiter Mensa.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Tag als YYYY-MM-DD' },
        items: {
          type: 'array',
          description: 'Gerichte mit Menge',
          items: {
            type: 'object',
            properties: { dish_id: { type: 'string', description: 'dish_id aus get_mensa_menu' }, quantity: { type: 'integer', description: 'Anzahl (1–20)' } },
            required: ['dish_id', 'quantity'],
          },
        },
        pickup_time: { type: 'string', description: 'Optional: Abholzeit HH:MM aus get_mensa_menu' },
      },
      required: ['date', 'items'],
    },
  },
  {
    name: 'place_mensa_order',
    description:
      'Bestellt verbindlich in der Mensa. Die App zeigt dem Nutzer vorher einen Bestätigungsdialog; bestellt wird erst nach seinem Klick. Der Name kommt aus dem Moodle-Konto. Der Abholschein geht an die E-Mail-Adresse.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Tag als YYYY-MM-DD' },
        items: {
          type: 'array',
          description: 'Gerichte mit Menge',
          items: {
            type: 'object',
            properties: { dish_id: { type: 'string', description: 'dish_id aus get_mensa_menu' }, quantity: { type: 'integer', description: 'Anzahl (1–20)' } },
            required: ['dish_id', 'quantity'],
          },
        },
        pickup_time: { type: 'string', description: 'Abholzeit HH:MM aus get_mensa_menu' },
        email: { type: 'string', description: 'E-Mail für den Abholschein. Weglassen, wenn laut get_mensa_menu schon eine in der App gespeichert ist.' },
      },
      required: ['date', 'items', 'pickup_time'],
    },
  },
];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LECTURER_TAG = /\s*\([A-ZÄÖÜ][A-Za-zÄÖÜäöü]{1,3}\)\s*$/;
const localIso = (d) => d.toLocaleDateString('sv-SE');
const fmtDay = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
const fmtClock = (ms) => new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const fmtEuro = (n) => (n == null ? '–' : n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' }));
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Name für Mensa-Bestellungen: in der App eingetragen, sonst aus dem Moodle-Konto
function orderName(site) {
  const st = store.getSettings();
  const first = String(st.mensaFirstName || '').trim() || String((site && site.firstname) || '').trim();
  let last = String(st.mensaLastName || '').trim() || String((site && site.lastname) || '').trim();
  // Ältere Caches kennen nur den vollen Namen
  if (!last && site && site.fullname && first && site.fullname.startsWith(first)) last = site.fullname.slice(first.length).trim();
  return { first, last };
}

// Werkzeuge, die der KI aktuell angeboten werden
function toolSpecs() {
  return gradesAllowed() ? TOOL_SPECS : TOOL_SPECS.filter((t) => t.name !== 'get_grades');
}

function validateInput(name, input) {
  const tool = toolSpecs().find((t) => t.name === name);
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
    'Du bist der Lernassistent in „Chadoodle“, einer Desktop-App, die die Moodle-Kurse einer/eines Studierenden lokal synchronisiert.',
    `Nutzer: ${(site && site.firstname) || 'unbekannt'} (Moodle: ${site ? site.sitename : '–'}). Heute ist ${today}.`,
    '',
    'Deine Hauptaufgabe: die Kursunterlagen durchsuchen, die passenden Stellen finden und verständlich erklären.',
    '- Suche zuerst mit search_documents in den Dokumenten und lies relevante Stellen mit read_pages, bevor du inhaltlich antwortest. Rate nicht, wenn die Unterlagen die Antwort enthalten können.',
    '- Probiere bei wenigen Treffern Synonyme, Fachbegriffe, Abkürzungen oder englische Begriffe.',
    '- Belege Aussagen mit Fundstellen und verlinke sie IMMER als Markdown-Link im Format [Dateiname, S. 12](doc://FILE_ID?page=12). Die App öffnet diese Links direkt an der Seite im PDF-Viewer.',
    '- Erkläre didaktisch: erst die Kernidee, dann Details, Formeln mit LaTeX ($…$ bzw. $$…$$), bei Bedarf ein kurzes Beispiel.',
    '- Wenn die Unterlagen etwas nicht abdecken, sag das und ergänze dann mit allgemeinem Fachwissen (klar gekennzeichnet).',
    gradesAllowed()
      ? '- Für Termine, Abgaben und Noten nutze get_deadlines, read_activity und get_grades.'
      : '- Für Termine und Abgaben nutze get_deadlines und read_activity. Auf Noten hast du keinen Zugriff; der Nutzer kann ihn unter Einstellungen → KI-Assistent freigeben.',
    '- Bei bewerteten Abgaben: erkläre, gib Hinweise und Feedback; eine fertige Lösung zum Abgeben schreibst du nicht, sondern hilfst Schritt für Schritt.',
    '- Stundenplan: get_timetable. Mensa: get_mensa_menu. Für „wann passt die Mensa?“ kombiniere beides – maßgeblich sind Abholzeit, Mindestpause und Essenszeit aus get_mensa_menu.',
    '- Mensa-Bestellung: Will der Nutzer bestellen, kläre Tag, Gerichte, Menge und Abholzeit (schlage eine Zeit vor, die in seine Pausen passt) und rufe dann place_mensa_order auf. Ist laut get_mensa_menu keine E-Mail gespeichert, frag nach der E-Mail-Adresse für den Abholschein. Die App lässt den Nutzer die Bestellung in einem Dialog bestätigen – frag deshalb im Chat nicht zusätzlich nach. Sag nur „bestellt“, wenn das Werkzeug eine Bestellnummer zurückgibt.',
    '- Will der Nutzer nur vormerken oder selbst abschicken, nutze prepare_mensa_cart und verlinke den Warenkorb als [Warenkorb öffnen](mensa://YYYY-MM-DD).',
    '- Antworte auf Deutsch (außer der Nutzer schreibt anders) und formatiere mit Markdown.',
  ].join('\n');
}

class AiTools {
  constructor(sync, index) {
    this.sync = sync;
    this.index = index;
    // Werden in main.js gesetzt: Stundenpläne, Mensa und der Weg zum Warenkorb im Fenster
    this.timetables = null;
    this.mensa = null;
    this.onPrepareCart = null;
    // Bestätigungsdialog im Fenster (→ Promise<boolean>) und Meldung nach erfolgreicher Bestellung
    this.confirmOrder = null;
    this.onOrdered = null;
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
      case 'get_timetable': return 'Schaut in den Stundenplan';
      case 'get_mensa_menu': return `Schaut auf den Speiseplan${input && ISO_DATE.test(input.date || '') ? ` (${fmtDay(input.date)})` : ''}`;
      case 'prepare_mensa_cart': return `Legt Essen in den Warenkorb${input && ISO_DATE.test(input.date || '') ? ` (${fmtDay(input.date)})` : ''}`;
      case 'place_mensa_order': return 'Bestellt in der Mensa – bitte im Dialog bestätigen';
      default: return name;
    }
  }

  // Liefert einen String oder (nur für Claude) Content-Blöcke
  async run(name, input, provider) {
    if (name === 'get_timetable') return this.timetableText(input);
    if (name === 'get_mensa_menu') return this.mensaText(input);
    if (name === 'prepare_mensa_cart') return this.prepareCart(input);
    if (name === 'place_mensa_order') return this.placeOrder(input);
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
        // Ohne Verfassernamen: personenbezogene Daten anderer bleiben lokal
        if (fo) for (const d of fo.discussions) out.push(`\n### ${d.subject}\n${fmtDate(d.created)}\n${stripHtml(d.message)}`);
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
        if (!gradesAllowed()) throw new Error('Zugriff auf Noten ist in den Einstellungen nicht freigegeben.');
        const g = c.grades[input.course_id];
        if (!g || !g.length) return 'Keine Bewertungen vorhanden.';
        return g
          .map((it) => `- ${stripHtml(it.name)}: ${it.grade || '–'}${it.range ? ` (Bereich ${it.range})` : ''}${it.percentage && it.percentage !== '-' ? `, ${it.percentage}` : ''}${it.feedback ? ` – Feedback: ${stripHtml(it.feedback)}` : ''}`)
          .join('\n');
      }
    }
    throw new Error('Unbekanntes Werkzeug');
  }

  // ---------- Stundenplan ----------
  // Nur Zeit, Titel und Raum – Beschreibung und Dozierenden-Kürzel („Elektronik (WiA)“) gehen nicht an den KI-Anbieter
  timetableText(input) {
    if (!this.timetables) throw new Error('Stundenplan nicht verfügbar');
    const list = this.timetables.list();
    const st = store.getSettings();
    const plan = list.find((t) => t.id === st.timetableActive) || list[0];
    if (!plan) return 'Es ist kein Stundenplan eingetragen (Reiter „Stundenplan“).';
    const from = ISO_DATE.test(input.from_date || '') ? input.from_date : localIso(new Date());
    const days = Math.max(1, Math.min(21, Number(input.days) || 7));
    const start = new Date(`${from}T00:00:00`);
    const end = new Date(start);
    end.setDate(end.getDate() + days);
    const events = this.timetables.events(plan.id, start.getTime(), end.getTime()).sort((a, b) => a.start - b.start);
    const out = [`Stundenplan „${plan.name}“ (Stand ${plan.fetchedAt ? fmtDate(plan.fetchedAt / 1000) : 'unbekannt'}${plan.error ? `, letzte Aktualisierung fehlgeschlagen: ${plan.error}` : ''})`];
    for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
      const iso = localIso(d);
      const dayEvents = events.filter((e) => localIso(new Date(e.start)) === iso || (e.allDay && e.start <= d.getTime() && e.end > d.getTime()));
      out.push(`\n${fmtDay(iso)}:`);
      if (!dayEvents.length) out.push('- keine Termine');
      for (const e of dayEvents) out.push(`- ${e.allDay ? 'ganztägig' : `${fmtClock(e.start)}–${fmtClock(e.end)}`} ${e.title.replace(LECTURER_TAG, '')}${e.location ? ` (${e.location})` : ''}`);
    }
    return out.join('\n');
  }

  // ---------- Mensa ----------
  async mensaText(input) {
    if (!this.mensa) throw new Error('Mensa nicht verfügbar');
    const data = await this.mensa.get();
    const only = ISO_DATE.test(input.date || '') ? input.date : null;
    const days = data.days.filter((d) => !only || d.date === only);
    const st = store.getSettings();
    const out = [
      `${data.name} – Speiseplan (Stand ${fmtDate(Math.round(data.fetchedAt / 1000))}${data.error ? `, Aktualisierung fehlgeschlagen: ${data.error}` : ''}).`,
      `Einstellungen des Nutzers für einen Mensabesuch: Abholung ${st.mensaPickupFrom || '11:45'}–${st.mensaPickupTo || '13:30'}, Pause mindestens ${st.mensaMinBreak || 44} Min., ab Abholbeginn ${st.mensaMinEat || 30} Min. zum Essen.`,
      `E-Mail für den Abholschein in der App gespeichert: ${EMAIL.test(String(st.mensaEmail || '').trim()) ? 'ja (bei place_mensa_order weglassen)' : 'nein – vor dem Bestellen erfragen'}.`,
    ];
    if (!days.length) return out.concat(only ? `Für ${fmtDay(only)} ist kein Speiseplan veröffentlicht.` : 'Es ist noch kein Speiseplan veröffentlicht.').join('\n');
    const opts = await Promise.all(days.map((d) => this.mensa.orderOptions(d.date, '').catch((e) => ({ error: e.message }))));
    const orders = this.mensa.orders();
    days.forEach((d, i) => {
      const o = opts[i];
      const stock = (o && o.stock) || {};
      const hasStock = Object.keys(stock).length > 0;
      const can = o && !o.error && o.orderable;
      out.push(`\n## ${fmtDay(d.date)}${d.rel ? ` (${d.rel})` : ''} – ${o.error ? `Bestellstatus unbekannt: ${o.error}` : can ? 'vorbestellbar' : `nicht mehr vorbestellbar (wieder ab ${fmtDay(o.earliest)})`}`);
      if (can) out.push(o.message ? `Abholzeiten: ${o.message}` : `Abholzeiten (Beginn, freie Plätze): ${o.slots.map((s) => `${s.time} (${s.free > 0 ? s.free : 'voll'})`).join(', ') || 'keine'}`);
      for (const x of orders.filter((x) => x.date === d.date)) out.push(`Bereits bestellt (Nr. ${x.no}): ${x.items.map((it) => `${it.n}× ${it.title}`).join(', ')}, Abholung ${x.time} Uhr`);
      for (const e of d.dishes) {
        const diet = e.tags.filter((t) => t.diet).map((t) => t.text);
        const allergens = e.tags.filter((t) => !t.diet).map((t) => t.text);
        const s = e.aid && stock[e.aid];
        const orderable = e.aid && (hasStock ? !!s : (e.prices.dhbw || e.prices.intern || 0) > 0);
        const status = !can ? '' : !orderable ? ' · nicht vorbestellbar' : s && (s.rest <= 0 || s.live <= 0) ? ' · ausverkauft' : ` · vorbestellbar${s ? `, noch ${s.live}` : ''}`;
        out.push(
          `- ${e.aid ? `[dish_id ${e.aid}] ` : ''}${e.category ? e.category + ': ' : ''}${e.title}${e.description ? ` – ${e.description}` : ''}` +
            `${diet.length ? ` · ${diet.join(', ')}` : ''}${allergens.length ? ` · Allergene/Zusätze: ${allergens.join(', ')}` : ''}` +
            ` · DHBW ${fmtEuro(e.prices.dhbw)} (intern ${fmtEuro(e.prices.intern)}, extern ${fmtEuro(e.prices.extern)})${status}`,
        );
      }
    });
    return out.join('\n');
  }

  // Warenkorb vorbereiten – geprüft wie in der App, abgeschickt wird hier nichts
  async prepareCart(input) {
    if (!this.onPrepareCart) throw new Error('Mensa nicht verfügbar');
    const { date, day, items, time } = await this.checkCart(input);
    this.onPrepareCart({ date, items, time });
    const lines = Object.entries(items).map(([aid, n]) => `${n}× ${day.dishes.find((x) => x.aid === aid).title}`);
    return `Warenkorb für ${fmtDay(date)} vorbereitet: ${lines.join(', ')}${time ? `, Abholung ${time} Uhr` : ', Abholzeit noch nicht gewählt'}. ` +
      'NOCH NICHT BESTELLT: Der Nutzer muss im Reiter Mensa Name/E-Mail prüfen, die Nutzungsvereinbarung bestätigen und selbst auf „Bestellen“ klicken. ' +
      `Link für den Nutzer: [Warenkorb öffnen](mensa://${date})`;
  }

  // Verbindlich bestellen – nur nach Klick des Nutzers im Bestätigungsdialog der App
  async placeOrder(input) {
    if (!this.confirmOrder) throw new Error('Mensa nicht verfügbar');
    if (!input.pickup_time) throw new Error('pickup_time fehlt – frag den Nutzer nach der Abholzeit.');
    const { date, day, items, time, slot, termsUrl } = await this.checkCart(input);
    const { first, last } = orderName(this.cache && this.cache.site);
    if (!first || !last) throw new Error('Der Name ist unbekannt. Der Nutzer soll Vor- und Nachname einmal im Reiter Mensa eintragen.');
    const given = String(input.email || '').trim();
    const email = given || String(store.getSettings().mensaEmail || '').trim();
    if (!email) throw new Error('Keine E-Mail-Adresse gespeichert – frag den Nutzer nach der E-Mail für den Abholschein.');
    if (!EMAIL.test(email)) throw new Error(`„${email}“ ist keine gültige E-Mail-Adresse – frag nochmal nach.`);

    const lines = Object.entries(items).map(([aid, n]) => {
      const e = day.dishes.find((x) => x.aid === aid);
      return { n, title: e.title, dhbw: e.prices.dhbw };
    });
    const ok = await this.confirmOrder({ date, label: fmtDay(date), time, until: slot.until, lines, firstName: first, lastName: last, email, termsUrl });
    if (!ok) return 'NICHT BESTELLT: Der Nutzer hat die Bestellung im Bestätigungsdialog abgebrochen. Frag, was geändert werden soll.';

    const entry = await this.mensa.order({ date, items, time, firstName: first, lastName: last, email });
    // Erfragte Adresse für das nächste Mal merken
    if (given && given !== store.getSettings().mensaEmail) store.setSettings({ mensaEmail: given });
    if (this.onOrdered) this.onOrdered(entry);
    return `BESTELLT – Bestellnummer ${entry.no}: ${lines.map((l) => `${l.n}× ${l.title}`).join(', ')} am ${fmtDay(date)}, Abholung ${entry.time}–${entry.until} Uhr. Der Abholschein kommt per E-Mail an ${entry.email}.`;
  }

  // Gemeinsame Prüfung für Warenkorb und Bestellung: Tag bestellbar, Gerichte vorbestellbar und vorrätig, Abholzeit frei
  async checkCart(input) {
    if (!this.mensa) throw new Error('Mensa nicht verfügbar');
    const date = String(input.date || '');
    if (!ISO_DATE.test(date)) throw new Error('date muss YYYY-MM-DD sein');
    if (!Array.isArray(input.items) || !input.items.length) throw new Error('items ist leer');
    const data = await this.mensa.get();
    const day = data.days.find((d) => d.date === date);
    if (!day) throw new Error(`Für ${fmtDay(date)} gibt es keinen Speiseplan.`);
    const o = await this.mensa.orderOptions(date, '');
    if (!o.orderable) throw new Error(`${fmtDay(date)} ist nicht mehr vorbestellbar (wieder ab ${fmtDay(o.earliest)}).`);
    const hasStock = Object.keys(o.stock).length > 0;
    const items = {};
    for (const it of input.items) {
      const aid = String((it && it.dish_id) || '');
      const n = Math.floor(Number(it && it.quantity));
      const e = day.dishes.find((x) => x.aid === aid);
      if (!e) throw new Error(`dish_id ${aid} gibt es am ${fmtDay(date)} nicht.`);
      if (!(n >= 1 && n <= 20)) throw new Error(`Menge für ${e.title} muss 1–20 sein.`);
      const s = o.stock[aid];
      if (hasStock ? !s : !(e.prices.dhbw || e.prices.intern)) throw new Error(`${e.title} kann nicht vorbestellt werden.`);
      if (s && (s.rest <= 0 || s.live < n)) throw new Error(`${e.title}: nur noch ${Math.max(0, s.live)} verfügbar.`);
      items[aid] = (items[aid] || 0) + n;
    }
    let slot = null;
    if (input.pickup_time) {
      slot = o.slots.find((s) => s.time === String(input.pickup_time).trim());
      if (!slot) throw new Error(`Abholzeit ${input.pickup_time} gibt es nicht. Möglich: ${o.slots.map((s) => s.time).join(', ')}`);
      if (slot.free <= 0) throw new Error(`Abholzeit ${slot.time} ist ausgebucht.`);
    }
    return { date, day, items, slot, time: slot ? slot.time : null, termsUrl: o.termsUrl };
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

module.exports = { AiTools, TOOL_SPECS, toolSpecs, validateInput, instructions };
