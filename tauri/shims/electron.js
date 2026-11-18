// Ersatz für „electron“ in der Tauri-Version: nur das, was die gemeinsamen Module benutzen.
// Die Betriebssystem-Arbeit erledigt Rust (src-tauri/src/main.rs).
const fs = require('fs');
const ENV = window.__CHADOODLE__;
const invoke = (...a) => window.__TAURI__.core.invoke(...a);
const winPath = (p) => String(p).replace(/\//g, '\\');

const app = {
  getPath: (name) => ({ userData: ENV.userData, documents: ENV.documents, appData: ENV.appData }[name] || ENV.userData + '/' + name),
  getVersion: () => ENV.version,
  getName: () => 'Chadoodle',
  isPackaged: ENV.packaged,
};

// Wie Electrons safeStorage unter Windows (gleiches Format, siehe src-tauri/src/secrets.rs)
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(fs.native('encrypt', { text: String(text) }).b64, 'base64'),
  decryptString: (buf) => fs.native('decrypt', { b64: Buffer.from(buf).toString('base64') }).text,
};

const shell = {
  openExternal: (url) => invoke('open_url', { url: String(url) }),
  openPath: (p) => invoke('open_path', { path: winPath(p) }),
  showItemInFolder: (p) => invoke('show_item', { path: winPath(p) }),
};

// Textextraktion im Web Worker statt im Electron-Hintergrundprozess (wie die Web-Version);
// die Seite liest die Datei asynchron und schickt die Bytes mit.
const utilityProcess = {
  fork() {
    const handlers = { message: [], exit: [] };
    const emit = (ev, data) => handlers[ev].forEach((fn) => fn(data));
    let worker = new Worker('/indexer.js', { type: 'module', name: 'Chadoodle Index' });
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
          const data = await fs.readFileAsync(msg.file);
          if (worker) worker.postMessage({ ...msg, data }, [data.buffer]);
        } catch (e) {
          emit('message', { id: msg.id, error: e.message });
        }
      },
      kill: exit,
    };
  },
};

module.exports = { app, safeStorage, shell, utilityProcess, BrowserWindow: null, session: null };
