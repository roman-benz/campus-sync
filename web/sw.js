// Service Worker der Web-Version:
//  /vfs/…    Dateien aus dem Browser-Speicher (Kursdateien, Kurs- und Profilbilder)
//  /mfile/…  Bilder/Dateien aus Moodle-Texten, mit Token geladen und für offline zwischengespeichert
//            (Gegenstück zum mfile://-Protokoll der Desktop-App)
//  sonst     App-Dateien: erst Netz, offline aus dem Cache
const idb = require('./shims/idb');

const SHELL = 'chadoodle-shell';
const MEDIA = 'chadoodle-media';
// Fremde Inhalte, die Skripte enthalten können (HTML, SVG, …), laufen in einem abgeschotteten
// Ursprung: so kommen sie nicht an den Speicher der App (Token, API-Key). PDFs, Bilder und Videos
// nicht – Chromes PDF-Ansicht verweigert abgeschottete Dokumente.
const SAFE = /^(application\/pdf|image\/(png|jpeg|gif|webp|bmp|x-icon)|video\/|audio\/|text\/plain)/i;
const isolate = (type) => ({ 'X-Content-Type-Options': 'nosniff', ...(SAFE.test(type) ? {} : { 'Content-Security-Policy': 'sandbox' }) });

const TYPES = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg',
  wav: 'audio/wav', ogg: 'audio/ogg', txt: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', json: 'application/json', xml: 'text/xml',
  zip: 'application/zip', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function sniff(bytes) {
  const b = bytes.subarray(0, 16);
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
  if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  const head = new TextDecoder().decode(bytes.subarray(0, 256)).trimStart();
  if (/^(<\?xml[^>]*>\s*)?<svg/i.test(head)) return 'image/svg+xml';
  return 'application/octet-stream';
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/vfs/')) return e.respondWith(serveVfs(url));
  if (url.pathname.startsWith('/mfile/')) return e.respondWith(serveMedia(url));
  if (url.pathname.startsWith('/api/')) return;
  e.respondWith(shell(e.request));
});

async function serveVfs(url) {
  const p = url.pathname.slice(4).split('/').map(decodeURIComponent).join('/');
  // Aus dem Profil nur zwischengespeicherte Bilder – Einstellungen, Token und Keys nie
  if (p.startsWith('/userData/') && !p.startsWith('/userData/cache/img/')) return new Response('nicht erlaubt', { status: 403 });
  let entry = await idb.get('files', p);
  let data = entry && entry.data;
  if (data === undefined) data = await idb.get('blobs', p);
  if (data === undefined) return new Response('nicht vorhanden', { status: 404 });
  if (typeof data === 'string') data = new TextEncoder().encode(data);
  if (data instanceof Blob) data = new Uint8Array(await data.arrayBuffer());
  const name = p.split('/').pop();
  const ext = (/\.([a-z0-9]+)$/i.exec(name) || [])[1];
  const type = (ext && TYPES[ext.toLowerCase()]) || sniff(data);
  return new Response(data, {
    headers: { 'Content-Type': type, 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}`, 'Cache-Control': 'no-store', ...isolate(type) },
  });
}

// Anmeldedaten liest der Service Worker aus demselben Speicher wie die Seite (shims/fs.js)
async function session() {
  const read = async (p) => {
    const e = await idb.get('files', p);
    if (!e) return {};
    try {
      return JSON.parse(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data));
    } catch {
      return {};
    }
  };
  const [settings, secrets] = await Promise.all([read('/userData/settings.json'), read('/userData/secrets.json')]);
  const token = secrets.moodleToken ? new TextDecoder().decode(Uint8Array.from(atob(secrets.moodleToken), (c) => c.charCodeAt(0))) : null;
  return { siteUrl: settings.siteUrl || 'https://elearning.dhbw-ravensburg.de', token };
}

// Wie MoodleClient.isSiteUrl/fileUrl: das Token geht nur an die eigene Moodle-Seite
function isSiteUrl(raw, siteUrl) {
  try {
    const u = new URL(raw);
    const site = new URL(siteUrl);
    const base = site.pathname.replace(/\/+$/, '');
    return u.origin === site.origin && (!base || u.pathname === base || u.pathname.startsWith(base + '/'));
  } catch {
    return false;
  }
}

async function serveMedia(url) {
  const raw = decodeURIComponent(url.pathname.slice('/mfile/'.length));
  const { siteUrl, token } = await session();
  if (!isSiteUrl(raw, siteUrl)) return new Response('nicht erlaubt', { status: 403 });
  const cache = await caches.open(MEDIA);
  const key = new Request(new URL('/mfile/' + encodeURIComponent(raw.split('?')[0]), self.location.origin));
  try {
    if (!token) throw new Error('offline');
    let target = raw;
    if (/\/pluginfile\.php\//.test(raw)) {
      target = raw.replace(/\/pluginfile\.php\//, '/webservice/pluginfile.php/').replace('/webservice/webservice/', '/webservice/');
      target += (target.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
    }
    const res = await fetch(target, { credentials: 'omit' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.arrayBuffer();
    const type = res.headers.get('content-type') || sniff(new Uint8Array(body));
    const out = new Response(body, { headers: { 'Content-Type': type, ...isolate(type) } });
    await cache.put(key, out.clone());
    return out;
  } catch {
    return (await cache.match(key)) || new Response('nicht verfügbar', { status: 404 });
  }
}

async function shell(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') cache.put(req, res.clone());
    return res;
  } catch (e) {
    const hit = (await cache.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' && (await cache.match('/')));
    if (hit) return hit;
    throw e;
  }
}
