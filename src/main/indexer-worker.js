// Hintergrundprozess (Electron utilityProcess): extrahiert Text aus einzelnen Dokumenten.
const { extractPages } = require('./extract');

process.parentPort.on('message', async (e) => {
  const { id, file, filename } = e.data;
  try {
    const pages = await extractPages(file, filename);
    process.parentPort.postMessage({ id, pages });
  } catch (err) {
    process.parentPort.postMessage({ id, error: String(err && err.message ? err.message : err) });
  }
});
