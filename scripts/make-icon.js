// Rendert das App-Icon aus einem SVG in alle benötigten Größen – Aufruf: npm run icon
//   build/icon.png (512, Website/Electron), src-tauri/icons/* (PNG + ICO), ios/Resources/AppIcon.png (1024)
// Farben: App-Palette „Graphit & Petrol“ – #1B1F27 / #F2F4F7, Akzent #0E7C86.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const svg = (size, rounded = true) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  ${rounded ? '<rect x="16" y="16" width="480" height="480" rx="112" fill="#1b1f27"/>' : '<rect width="512" height="512" fill="#1b1f27"/>'}
  <g transform="translate(0 6)">
    <path d="M142 330h228a22 22 0 0 1 0 44H142a22 22 0 0 1 0-44z" fill="#0e7c86"/>
    <path d="M168 346h170" stroke="#f2f4f7" stroke-width="8" stroke-linecap="round" opacity=".85"/>
    <path d="M96 186 256 112l160 74-160 76z" fill="#f2f4f7"/>
    <path d="M162 222v62c0 22 42 40 94 40s94-18 94-40v-62l-94 44z" fill="#f2f4f7" opacity=".92"/>
    <path d="M410 190v86" stroke="#0e7c86" stroke-width="16" stroke-linecap="round"/>
    <circle cx="410" cy="284" r="16" fill="#0e7c86"/>
  </g>
</svg>`;

async function render(win, size, rounded) {
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg(size, rounded)}</body></html>`));
  await new Promise((r) => setTimeout(r, 250));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  return img.getSize().width === size ? img : img.resize({ width: size, height: size, quality: 'best' });
}

// ICO mit eingebetteten PNGs (von Windows ab Vista unterstützt)
function ico(pngs) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([head, dir, ...pngs.map((p) => p.data)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, useContentSize: true, enableLargerThanScreen: true, show: false, transparent: true, frame: false, webPreferences: { offscreen: true, zoomFactor: 1 } });
  win.setContentSize(1024, 1024);
  const root = path.join(__dirname, '..');
  const write = (rel, buf) => {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, buf);
    console.log('geschrieben:', rel);
  };
  const big = await render(win, 1024, true);
  const at = (n) => big.resize({ width: n, height: n, quality: 'best' }).toPNG();
  write('build/icon.png', at(512));
  write('src-tauri/icons/icon.png', at(512));
  write('src-tauri/icons/32x32.png', at(32));
  write('src-tauri/icons/64x64.png', at(64));
  write('src-tauri/icons/128x128.png', at(128));
  write('src-tauri/icons/128x128@2x.png', at(256));
  write('src-tauri/icons/icon.ico', ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, data: at(size) }))));
  // iOS rundet selbst ab: volle Fläche ohne Transparenz
  const ios = await render(win, 1024, false);
  write('ios/Resources/AppIcon.png', ios.toPNG());
  app.quit();
});
