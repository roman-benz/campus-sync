// Cloudflare Pages Function: Weiterleitung für Dienste, die keine Browser-Zugriffe (CORS) erlauben.
// Bewusst eng begrenzt, damit daraus kein offener Proxy wird:
//  - my-mensa.de (Speiseplan und Vorbestellung): GET und POST
//  - sonst nur GET, und die Antwort muss ein iCal-Kalender sein (Stundenpläne, z. B. Rapla)
// Cookies und sonstige Kopfzeilen werden nicht weitergegeben.
const MENSA = /(^|\.)my-mensa\.de$/i;
const FORWARD = ['content-type', 'accept', 'x-requested-with'];
const MAX_BYTES = 8 * 1024 * 1024;

export async function onRequest({ request }) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  // Nur Aufrufe der eigenen Seite (Browser setzen Origin bei POST bzw. Sec-Fetch-Site immer)
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  if ((origin && origin !== url.origin) || (site && site !== 'same-origin')) return text('Nicht erlaubt', 403);

  let target;
  try {
    target = new URL(url.searchParams.get('url') || '');
  } catch {
    return text('Ungültige Adresse', 400);
  }
  if (target.protocol !== 'https:' || target.port) return text('Nur https', 400);
  const mensa = MENSA.test(target.hostname);
  if (!mensa && request.method !== 'GET') return text('Nicht erlaubt', 405);
  if (mensa && !['GET', 'POST'].includes(request.method)) return text('Nicht erlaubt', 405);

  const headers = new Headers({ 'User-Agent': 'Chadoodle (+https://chadoodle.romanbenz.com)' });
  for (const h of FORWARD) if (request.headers.has(h)) headers.set(h, request.headers.get(h));
  let res;
  try {
    res = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === 'POST' ? await request.arrayBuffer() : undefined,
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    return text('Ziel nicht erreichbar', 502);
  }
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) return text('Antwort zu groß', 502);
  const body = await res.arrayBuffer();
  if (body.byteLength > MAX_BYTES) return text('Antwort zu groß', 502);
  if (!mensa && res.ok && !/BEGIN:VCALENDAR/i.test(new TextDecoder().decode(body.slice(0, 4096)))) {
    return text('Unter diesem Link liegt kein Kalender (iCal).', 415);
  }
  return new Response(body, {
    status: res.status,
    headers: {
      'Content-Type': res.headers.get('content-type') || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': 'sandbox',
    },
  });
}

const text = (msg, status) => new Response(msg, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
