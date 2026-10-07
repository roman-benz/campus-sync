// Ersatz für Nodes „url“: Dateien aus dem Browser-Speicher liefert der Service Worker unter /vfs/…
const vfsUrl = (p) => '/vfs' + String(p).split('/').map(encodeURIComponent).join('/');

module.exports = {
  URL: globalThis.URL,
  URLSearchParams: globalThis.URLSearchParams,
  pathToFileURL: (p) => ({ href: vfsUrl(p), toString: () => vfsUrl(p) }),
  vfsUrl,
};
