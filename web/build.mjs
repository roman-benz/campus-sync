// Baut die Web-Version nach web/dist (Cloudflare Pages: Build-Befehl „npm run web:build“).
// Oberfläche und Logik kommen unverändert aus src/; hier werden sie nur gebündelt und
// die Node-/Electron-Teile durch die Browser-Shims in web/shims ersetzt.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'web', 'dist');
const r = (...p) => path.join(root, ...p);
const pkg = JSON.parse(fs.readFileSync(r('package.json'), 'utf8'));

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// ---------- Oberfläche (src/renderer) ----------
const vendorPath = (s) => s.replaceAll('../../node_modules/', '/vendor/');
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  // Moodle-Seiten (frei wählbar), my-mensa und die Anthropic-API
  "connect-src 'self' https:",
].join('; ');

let html = fs.readFileSync(r('src/renderer/index.html'), 'utf8');
html = vendorPath(html)
  .replace(/<meta http-equiv="Content-Security-Policy"[\s\S]*?\/>/, `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`)
  .replace('<meta charset="utf-8" />', `<meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="${pkg.description}" />
  <meta name="theme-color" content="#0f6cbf" />
  <link rel="icon" href="/icon.png" />
  <link rel="apple-touch-icon" href="/icon.png" />
  <link rel="manifest" href="/manifest.webmanifest" />`)
  .replace('<link rel="stylesheet" href="styles.css" />', '<link rel="stylesheet" href="/styles.css" />\n  <link rel="stylesheet" href="/web.css" />')
  .replace('<script src="icons.js"></script>', '<script src="/backend.js"></script>\n  <script src="/icons.js"></script>')
  .replace('<script src="app.js"></script>', '<script src="/app.js"></script>');
fs.writeFileSync(path.join(out, 'index.html'), html);

for (const f of ['app.js', 'icons.js', 'styles.css']) fs.copyFileSync(r('src/renderer', f), path.join(out, f));
// viewer.js lädt pdf.js relativ zu sich selbst
fs.writeFileSync(path.join(out, 'viewer.js'), fs.readFileSync(r('src/renderer/viewer.js'), 'utf8').replaceAll('../../node_modules/', './vendor/'));

// ---------- Bibliotheken ----------
const copy = (from, to = from) => fs.cpSync(r('node_modules', from), path.join(out, 'vendor', to), { recursive: true });
copy('katex/dist');
copy('marked/lib/marked.umd.js');
copy('dompurify/dist/purify.min.js');
for (const f of ['pdf.mjs', 'pdf.worker.mjs']) copy(`pdfjs-dist/build/${f}`);
for (const d of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) if (fs.existsSync(r('node_modules/pdfjs-dist', d))) copy(`pdfjs-dist/${d}`);

// ---------- Statisches ----------
fs.copyFileSync(r('build/icon.png'), path.join(out, 'icon.png'));
for (const f of fs.readdirSync(r('web/static'))) fs.copyFileSync(r('web/static', f), path.join(out, f));
fs.writeFileSync(
  path.join(out, 'manifest.webmanifest'),
  JSON.stringify({
    name: pkg.productName,
    short_name: pkg.productName,
    description: pkg.description,
    lang: 'de',
    start_url: '/',
    display: 'standalone',
    background_color: '#f5f7fa',
    theme_color: '#0f6cbf',
    icons: [{ src: '/icon.png', sizes: '512x512', type: 'image/png', purpose: 'any' }],
  }, null, 2),
);

// ---------- Logik (src/main) für den Browser bündeln ----------
const shim = (f) => r('web/shims', f);
const common = {
  bundle: true,
  platform: 'browser',
  target: ['chrome120', 'firefox121', 'safari17'],
  minify: true,
  sourcemap: true,
  logLevel: 'warning',
  define: { 'process.env': '{}', global: 'globalThis', __dirname: '"/"', 'globalThis.CHADOODLE_VERSION': JSON.stringify(pkg.version) },
  inject: [shim('globals.js')],
  alias: {
    path: 'path-browserify',
    url: shim('url.js'),
    crypto: shim('crypto.js'),
    http: shim('empty.js'),
    stream: shim('empty.js'),
    'stream/promises': shim('empty.js'),
  },
};

const builds = [
  { ...common, entryPoints: [r('web/backend.js')], outfile: path.join(out, 'backend.js'), format: 'iife', alias: { ...common.alias, fs: shim('fs.js'), electron: shim('electron.js') } },
  { ...common, entryPoints: [r('web/indexer-worker.js')], outfile: path.join(out, 'indexer.js'), format: 'esm', alias: { ...common.alias, fs: shim('worker-fs.js') } },
  { ...common, entryPoints: [r('web/sw.js')], outfile: path.join(out, 'sw.js'), format: 'iife', inject: [] },
];

await Promise.all(builds.map((b) => esbuild.build(b)));
console.log(`Web-Version ${pkg.version} gebaut: ${path.relative(root, out)}`);
