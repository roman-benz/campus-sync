// Web Worker: extrahiert Text aus einzelnen Dokumenten (Gegenstück zu src/main/indexer-worker.js).
import * as pdfjs from 'pdfjs-dist/build/pdf.mjs';
import * as pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs';
import { files } from './shims/worker-fs.js';
import { extractPages, setPdfjsLoader } from '../src/main/extract.js';

// Im Worker gibt es keinen weiteren Worker für pdf.js: dessen Teil im selben Thread laufen lassen
globalThis.pdfjsWorker = pdfjsWorker;
setPdfjsLoader(async () => pdfjs);

self.onmessage = async (e) => {
  const { id, file, filename, data } = e.data;
  files.set(file, data);
  try {
    const pages = await extractPages(file, filename);
    self.postMessage({ id, pages });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message ? err.message : err) });
  } finally {
    files.delete(file);
  }
};
