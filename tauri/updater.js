// Automatische Updates der Tauri-Version (gleiche Schnittstelle wie src/main/updater.js).
// Rust prüft die GitHub-Releases (latest.json, signiert), lädt im Hintergrund und installiert,
// sobald die App unbemerkt neu starten kann (Fenster versteckt, kein Sync/Chat aktiv).
const { EventEmitter } = require('events');
const { app } = require('electron');

const CHECK_EVERY_MS = 3 * 60 * 60 * 1000;
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

class Updater extends EventEmitter {
  constructor({ canRestartSilently, beforeInstall }) {
    super();
    this.canRestartSilently = canRestartSilently;
    this.beforeInstall = beforeInstall;
    this.status = { state: app.isPackaged ? 'idle' : 'dev', version: null, progress: 0, message: '' };
    this.timer = null;
  }

  set(patch) {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.status);
  }

  start() {
    if (!app.isPackaged) return;
    listen('update:event', ({ payload: e }) => {
      if (e.type === 'checking') this.set({ state: 'checking', message: '' });
      else if (e.type === 'none') this.set({ state: 'uptodate', lastCheck: Date.now() });
      else if (e.type === 'available') this.set({ state: 'downloading', version: e.version, progress: 0 });
      else if (e.type === 'progress') this.set({ state: 'downloading', progress: e.percent });
      else if (e.type === 'error') this.set({ state: 'error', message: String(e.message || '').split('\n')[0], lastCheck: Date.now() });
      else if (e.type === 'downloaded') {
        this.set({ state: 'ready', version: e.version, progress: 100 });
        // Gerade beschäftigt (Sync, Chat, Index) oder Fenster offen? Dann jede Minute erneut probieren.
        if (!this.tryInstallSilently() && !this.retry) {
          this.retry = setInterval(() => this.tryInstallSilently() && clearInterval(this.retry), 60 * 1000);
        }
      }
    });
    setTimeout(() => this.check(), 20 * 1000);
    this.timer = setInterval(() => (this.status.state === 'ready' ? this.tryInstallSilently() : this.check()), CHECK_EVERY_MS);
  }

  check() {
    if (!app.isPackaged || ['downloading', 'ready'].includes(this.status.state)) return;
    invoke('update_check').catch(() => {});
  }

  tryInstallSilently() {
    if (this.status.state !== 'ready' || !this.canRestartSilently()) return false;
    this.beforeInstall({ hidden: true });
    setTimeout(() => invoke('update_install').catch((e) => this.set({ state: 'error', message: String(e) })));
    return true;
  }

  installNow() {
    if (this.status.state !== 'ready') return;
    this.beforeInstall({ hidden: false });
    setTimeout(() => invoke('update_install').catch((e) => this.set({ state: 'error', message: String(e) })));
  }
}

module.exports = { Updater };
