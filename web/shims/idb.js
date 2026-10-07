// Gemeinsamer IndexedDB-Zugriff für Seite und Service Worker.
// „files“: kleine Dateien (Einstellungen, Cache, Textindex) – beim Start komplett im Speicher.
// „blobs“: heruntergeladene Kursdateien – nur auf Abruf gelesen, Größe/Zeit stehen in „blobmeta“.
const DB_NAME = 'chadoodle';
const DB_VERSION = 1;

let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of ['files', 'blobs', 'blobmeta']) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const done = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

async function get(store, key) {
  const db = await openDb();
  return done(db.transaction(store).objectStore(store).get(key));
}

async function getAll(store) {
  const db = await openDb();
  const os = db.transaction(store).objectStore(store);
  const [keys, values] = await Promise.all([done(os.getAllKeys()), done(os.getAll())]);
  return keys.map((k, i) => [k, values[i]]);
}

// ops: [{ store, key, value }] – value undefined = löschen. Eine Transaktion für alles.
async function write(ops) {
  if (!ops.length) return;
  const db = await openDb();
  const stores = [...new Set(ops.map((o) => o.store))];
  const tx = db.transaction(stores, 'readwrite');
  for (const o of ops) {
    const os = tx.objectStore(o.store);
    if (o.value === undefined) os.delete(o.key);
    else os.put(o.value, o.key);
  }
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

module.exports = { openDb, get, getAll, write };
