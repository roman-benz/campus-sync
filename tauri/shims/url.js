// „url“ der Tauri-Version: lokale Dateien liefert das eigene Protokoll unter /vfs/… aus
// (file://-Adressen darf die Oberfläche nicht laden).
const vfsUrl = (p) => '/vfs/' + String(p).replace(/\\/g, '/').replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');

module.exports = {
  URL: globalThis.URL,
  URLSearchParams: globalThis.URLSearchParams,
  pathToFileURL: (p) => ({ href: vfsUrl(p), toString: () => vfsUrl(p) }),
  fileURLToPath: (u) => decodeURIComponent(new URL(u).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  vfsUrl,
};
