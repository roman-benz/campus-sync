// Textextraktion aus Kursdokumenten → Seiten (PDF-Seiten, Folien, Tabellenblätter, Textabschnitte).
// Läuft im Index-Hintergrundprozess, damit die Oberfläche nicht ruckelt.
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const TEXT_EXT = new Set([
  '.txt', '.md', '.csv', '.tsv', '.json', '.xml', '.html', '.htm', '.tex', '.py', '.java', '.c', '.h', '.cpp',
  '.hpp', '.cs', '.js', '.ts', '.m', '.r', '.sql', '.vhd', '.vhdl', '.v', '.sv', '.asm', '.s', '.ino', '.yaml',
  '.yml', '.ini', '.log', '.sh', '.bat', '.ps1', '.kt', '.go', '.rs', '.php', '.rb', '.css',
]);
const OFFICE_EXT = new Set(['.docx', '.pptx', '.xlsx', '.odt', '.odp']);

const canExtract = (filename) => {
  const ext = path.extname(filename).toLowerCase();
  return ext === '.pdf' || TEXT_EXT.has(ext) || OFFICE_EXT.has(ext);
};

const decode = (x) =>
  x.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const xmlText = (x) =>
  decode(x.replace(/<\/(w:p|a:p|text:p|text:h)>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<[^>]+>/g, ''))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
const stripHtml = (h) =>
  decode(String(h || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d|tr)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' '))
    .replace(/\n{3,}/g, '\n\n')
    .trim();

// Lange Fließtexte in „Seiten“ von ~3500 Zeichen schneiden, damit Suche und Seitenzugriff funktionieren
function chunk(text, size = 3500) {
  const out = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim() || !out.length) out.push(rest);
  return out;
}

// Pfad eines pdf.js-Moduls als file://-URL (im Installer aus app.asar.unpacked)
function pdfjsUrl(rel) {
  let p = require.resolve(`pdfjs-dist/${rel}`);
  const unpacked = p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  if (unpacked !== p && fs.existsSync(unpacked)) p = unpacked;
  return require('url').pathToFileURL(p).href;
}

let pdfjsPromise = null;
let pdfjsLoader = loadPdfjs;
async function loadPdfjs() {
  const pdfjs = await import(pdfjsUrl('legacy/build/pdf.mjs'));
  // Im Electron-Hintergrundprozess gibt es keine Web-Worker: pdf.js-Worker im selben Prozess laden
  globalThis.pdfjsWorker = await import(pdfjsUrl('legacy/build/pdf.worker.mjs'));
  pdfjs.GlobalWorkerOptions.workerSrc = pdfjsUrl('legacy/build/pdf.worker.mjs');
  return pdfjs;
}

async function pdfPages(file) {
  pdfjsPromise = pdfjsPromise || pdfjsLoader();
  const pdfjs = await pdfjsPromise;
  const data = new Uint8Array(fs.readFileSync(file));
  const task = pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true, verbosity: 0 });
  const doc = await task.promise;
  const pages = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      let s = '';
      for (const it of tc.items) {
        if (!('str' in it)) continue;
        s += it.str + (it.hasEOL ? '\n' : ' ');
      }
      pages.push(s.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim());
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return pages;
}

async function officePages(file, ext) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const num = (n) => Number((n.match(/(\d+)\.xml$/) || [])[1] || 0);
  if (ext === '.docx') return chunk(xmlText(await zip.file('word/document.xml').async('string')));
  if (ext === '.odt') return chunk(xmlText(await zip.file('content.xml').async('string')));
  if (ext === '.odp') {
    const xml = await zip.file('content.xml').async('string');
    return [...xml.matchAll(/<draw:page[\s\S]*?<\/draw:page>/g)].map((m) => xmlText(m[0]));
  }
  if (ext === '.pptx') {
    const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => num(a) - num(b));
    const pages = [];
    for (const s of slides) {
      let txt = xmlText(await zip.file(s).async('string'));
      const notes = zip.file(`ppt/notesSlides/notesSlide${num(s)}.xml`);
      if (notes) {
        const n = xmlText(await notes.async('string')).replace(/^\d+\s*$/m, '').trim();
        if (n) txt += '\n\nNotizen: ' + n;
      }
      pages.push(txt);
    }
    return pages;
  }
  if (ext === '.xlsx') {
    const shared = zip.file('xl/sharedStrings.xml')
      ? [...(await zip.file('xl/sharedStrings.xml').async('string')).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => xmlText(m[1]))
      : [];
    const sheets = Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => num(a) - num(b));
    const pages = [];
    for (const s of sheets) {
      const xml = await zip.file(s).async('string');
      const rows = [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((r) =>
        [...r[1].matchAll(/<c([^>]*)>(?:[\s\S]*?<v>([\s\S]*?)<\/v>)?[\s\S]*?<\/c>/g)]
          .map((cm) => (/t="s"/.test(cm[1]) ? shared[Number(cm[2])] : cm[2] || ''))
          .join('\t')
      );
      pages.push(rows.join('\n'));
    }
    return pages;
  }
  return null;
}

async function extractPages(file, filename) {
  const ext = path.extname(filename || file).toLowerCase();
  if (ext === '.pdf') return pdfPages(file);
  if (OFFICE_EXT.has(ext)) return officePages(file, ext);
  if (TEXT_EXT.has(ext)) {
    let t = fs.readFileSync(file, 'utf8');
    if (ext === '.html' || ext === '.htm') t = stripHtml(t);
    return chunk(t);
  }
  throw new Error(`Dateiformat ${ext || 'unbekannt'} kann nicht gelesen werden.`);
}

// Web-Version: pdf.js wird dort gebündelt statt über Dateipfade geladen
function setPdfjsLoader(fn) {
  pdfjsLoader = fn;
  pdfjsPromise = null;
}

module.exports = { extractPages, canExtract, stripHtml, setPdfjsLoader, TEXT_EXT, OFFICE_EXT };
