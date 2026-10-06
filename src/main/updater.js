// Automatische Updates aus den GitHub-Releases (github.com/roman-benz/moodle-desktop).
// Updates werden im Hintergrund geladen und still installiert, sobald die App unbemerkt neu
// starten kann (Fenster versteckt, kein Sync/Chat aktiv) – sonst beim nächsten Beenden.
const { app } = require('electron');
const { EventEmitter } = require('events');
const { autoUpdater } = require('electron-updater');

const CHECK_EVERY_MS = 3 * 60 * 60 * 1000;

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
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;
    // Nur für Tests: anderen Update-Server verwenden (Standard steht in package.json → publish)
    if (process.env.MOODLE_DESKTOP_UPDATE_URL) {
      autoUpdater.setFeedURL({ provider: 'generic', url: process.env.MOODLE_DESKTOP_UPDATE_URL });
    }

    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking', message: '' }));
    autoUpdater.on('update-not-available', () => this.set({ state: 'uptodate', lastCheck: Date.now() }));
    autoUpdater.on('update-available', (info) => this.set({ state: 'downloading', version: info.version, progress: 0 }));
    autoUpdater.on('download-progress', (p) => this.set({ state: 'downloading', progress: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (info) => {
      this.set({ state: 'ready', version: info.version, progress: 100 });
      this.tryInstallSilently();
    });
    autoUpdater.on('error', (err) => this.set({ state: 'error', message: String(err && err.message ? err.message : err).split('\n')[0], lastCheck: Date.now() }));

    setTimeout(() => this.check(), 20 * 1000);
    this.timer = setInterval(() => (this.status.state === 'ready' ? this.tryInstallSilently() : this.check()), CHECK_EVERY_MS);
  }

  check() {
    if (!app.isPackaged || ['downloading', 'ready'].includes(this.status.state)) return;
    autoUpdater.checkForUpdates().catch(() => {});
  }

  tryInstallSilently() {
    if (this.status.state !== 'ready' || !this.canRestartSilently()) return false;
    this.beforeInstall({ hidden: true });
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return true;
  }

  installNow() {
    if (this.status.state !== 'ready') return;
    this.beforeInstall({ hidden: false });
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
  }
}

module.exports = { Updater };
