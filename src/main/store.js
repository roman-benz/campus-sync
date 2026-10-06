// Persistente Einstellungen + verschlüsselte Geheimnisse (Moodle-Token, Claude-API-Key).
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  siteUrl: 'https://elearning.dhbw-ravensburg.de',
  downloadDir: '',
  syncIntervalMin: 30,
  autoDownload: true,
  maxFileSizeMB: 200,
  runInBackground: true,
  startWithWindows: true,
  notifications: true,
  theme: 'system',
  claudeModel: 'claude-opus-5',
  aiProvider: 'claude',
  chatgptModel: '',
  aiEffort: 'balanced',
};

function file(name) {
  return path.join(app.getPath('userData'), name);
}

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, p);
}

let settings = null;

const SETTINGS_VERSION = 2;

// In settings.json stehen nur selbst geänderte Werte – neue Standardwerte greifen so auch bei Updates.
function getSettings() {
  if (!settings) {
    const saved = readJson(file('settings.json'), {});
    if ((saved.settingsVersion || 1) < SETTINGS_VERSION) {
      // Bis 1.0.x wurden alle Standardwerte mitgespeichert; der Autostart war in Vorabversionen noch aus.
      delete saved.startWithWindows;
      saved.settingsVersion = SETTINGS_VERSION;
      writeJson(file('settings.json'), saved);
    }
    settings = { ...DEFAULTS, ...saved };
    if (!settings.downloadDir) {
      settings.downloadDir = path.join(app.getPath('documents'), 'Moodle Desktop');
    }
  }
  return settings;
}

function setSettings(patch) {
  const saved = { ...readJson(file('settings.json'), {}), ...patch, settingsVersion: SETTINGS_VERSION };
  writeJson(file('settings.json'), saved);
  settings = null;
  return getSettings();
}

// Geheimnisse werden mit Windows DPAPI (safeStorage) verschlüsselt abgelegt.
function getSecret(key) {
  const all = readJson(file('secrets.json'), {});
  if (!all[key]) return null;
  try {
    const buf = Buffer.from(all[key], 'base64');
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
  } catch {
    return null;
  }
}

function setSecret(key, value) {
  const all = readJson(file('secrets.json'), {});
  if (value == null || value === '') {
    delete all[key];
  } else {
    const buf = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(value)
      : Buffer.from(value, 'utf8');
    all[key] = buf.toString('base64');
  }
  writeJson(file('secrets.json'), all);
}

module.exports = { getSettings, setSettings, getSecret, setSecret, readJson, writeJson, file };
