// Baut die Oberfläche der Tauri-Version nach tauri/dist (wird ins Programm eingebettet).
// Oberfläche und Logik kommen unverändert aus src/; hier werden sie nur gebündelt und die
// Node-/Electron-Teile durch die Shims in tauri/shims ersetzt (wie web/build.mjs für den Browser).
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'tauri', 'dist');
const r = (...p) => path.join(root, ...p);
const pkg = JSON.parse(fs.readFileSync(r('package.json'), 'utf8'));
const dev = process.argv.includes('--dev');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// ---------- Oberfläche (src/renderer) ----------
const vendorPath = (s) => s.replaceAll('../../node_modules/', '/vendor/');
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  // Tauri-IPC, Supabase-Realtime (wss); alle übrigen Anfragen laufen über Rust
  "connect-src 'self' ipc: http://ipc.localhost https: wss:",
].join('; ');

let html = fs.readFileSync(r('src/renderer/index.html'), 'utf8');
html = vendorPath(html)
  .replace(/<meta http-equiv="Content-Security-Policy"[\s\S]*?\/>/, `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`)
  .replace('<link rel="stylesheet" href="styles.css" />', '<link rel="stylesheet" href="/styles.css" />')
  .replace('<script src="icons.js"></script>', '<script src="/backend.js"></script>\n  <script src="/icons.js"></script>')
  .replace('<script src="tt-proposal.js"></script>', '<script src="/tt-proposal.js"></script>')
  .replace('<script src="insights.js"></script>', '<script src="/insights.js"></script>')
  .replace('<script src="app.js"></script>', '<script src="/app.js"></script>');
if (!html.includes('/backend.js')) throw new Error('index.html: Einstiegspunkt für backend.js nicht gefunden');
fs.writeFileSync(path.join(out, 'index.html'), html);

for (const f of ['app.js', 'icons.js', 'tt-proposal.js', 'insights.js', 'styles.css']) fs.copyFileSync(r('src/renderer', f), path.join(out, f));
// viewer.js lädt pdf.js relativ zu sich selbst
fs.writeFileSync(path.join(out, 'viewer.js'), fs.readFileSync(r('src/renderer/viewer.js'), 'utf8').replaceAll('../../node_modules/', './vendor/'));

// ---------- Bibliotheken ----------
const copy = (from, to = from) => fs.cpSync(r('node_modules', from), path.join(out, 'vendor', to), { recursive: true });
copy('katex/dist');
copy('@fontsource-variable/inter/opsz.css');
copy('@fontsource-variable/inter/files');
copy('marked/lib/marked.umd.js');
copy('dompurify/dist/purify.min.js');
for (const f of ['pdf.mjs', 'pdf.worker.mjs']) copy(`pdfjs-dist/build/${f}`);
for (const d of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) if (fs.existsSync(r('node_modules/pdfjs-dist', d))) copy(`pdfjs-dist/${d}`);
fs.copyFileSync(r('build/icon.png'), path.join(out, 'icon.png'));

// ---------- Logik (src/main) bündeln ----------
const shim = (f) => r('tauri/shims', f);
// Die KI-SDKs über kleine Hüllen laden (Freigabe für die WebView); die Hüllen selbst bekommen das Original
const sdkPlugin = {
  name: 'sdk',
  setup(b) {
    b.onResolve({ filter: /^(@anthropic-ai\/sdk|openai)$/ }, (a) => {
      if (a.importer.startsWith(r('tauri', 'shims'))) return undefined;
      return { path: shim(a.path === 'openai' ? 'openai.js' : 'anthropic.js') };
    });
  },
};
const common = {
  bundle: true,
  platform: 'browser',
  target: ['chrome120'],
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  logLevel: 'warning',
  define: { 'process.env': '{}', global: 'globalThis', __dirname: '"/"' },
  inject: [r('web/shims/globals.js')],
};

await Promise.all([
  esbuild.build({
    ...common,
    entryPoints: [r('tauri/backend.js')],
    outfile: path.join(out, 'backend.js'),
    format: 'iife',
    plugins: [sdkPlugin],
    alias: {
      fs: shim('fs.js'),
      path: shim('path.js'),
      url: shim('url.js'),
      crypto: shim('crypto.js'),
      http: shim('http.js'),
      electron: shim('electron.js'),
      stream: r('web/shims/empty.js'),
      'stream/promises': r('web/shims/empty.js'),
    },
  }),
  // Index-Worker: derselbe wie in der Web-Version (die Seite schickt die Dateibytes mit)
  esbuild.build({
    ...common,
    entryPoints: [r('web/indexer-worker.js')],
    outfile: path.join(out, 'indexer.js'),
    format: 'esm',
    alias: { path: 'path-browserify', url: r('web/shims/url.js'), crypto: r('web/shims/crypto.js'), fs: r('web/shims/worker-fs.js') },
  }),
]);
console.log(`Tauri-Oberfläche ${pkg.version} gebaut: ${path.relative(root, out)}`);
