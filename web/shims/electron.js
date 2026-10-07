// Ersatz für „electron“ im Browser: nur das, was die gemeinsamen Module wirklich benutzen.
const vfs = require('./fs');

const app = {
  getPath: (name) => (name === 'documents' ? '/Dokumente' : name === 'userData' ? '/userData' : '/' + name),
  getVersion: () => globalThis.CHADOODLE_VERSION || '0.0.0',
  getName: () => 'Chadoodle',
  isPackaged: false,
};

// Kein Betriebssystem-Schlüsselbund im Browser: Geheimnisse bleiben im Browser-Speicher dieser Seite
const safeStorage = { isEncryptionAvailable: () => false };

const shell = {
  openExternal: (url) => window.open(url, '_blank', 'noopener'),
};

// Textextraktion im Web Worker statt im Electron-Hintergrundprozess. Die Datei liest die Seite
// aus IndexedDB und schickt die Bytes mit.
const utilityProcess = {
  fork() {
    const handlers = { message: [], exit: [] };
    const emit = (ev, data) => handlers[ev].forEach((fn) => fn(data));
    let worker = new Worker(new URL('/indexer.js', location.href), { type: 'module', name: 'Chadoodle Index' });
    let exited = false;
    const exit = () => {
      if (exited) return;
      exited = true;
      if (worker) worker.terminate();
      worker = null;
      emit('exit');
    };
    worker.onmessage = (e) => emit('message', e.data);
    worker.onerror = (e) => {
      console.error('Indexprozess', e.message || e);
      exit();
    };
    return {
      on(ev, fn) {
        (handlers[ev] = handlers[ev] || []).push(fn);
      },
      async postMessage(msg) {
        try {
          const data = (await vfs.readFileAsync(msg.file)).slice();
          if (worker) worker.postMessage({ ...msg, data }, [data.buffer]);
        } catch (e) {
          emit('message', { id: msg.id, error: e.message });
        }
      },
      kill: exit,
    };
  },
};

module.exports = { app, safeStorage, shell, utilityProcess };
