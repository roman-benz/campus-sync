// Zugangsschutz für die ganze Website: Ohne gültiges Zugangs-Cookie gibt es nur die Login-Seite.
// Gilt für alles (App-Dateien, Proxy, Service Worker) – außer dem Login selbst und dem Icon.
import { verify } from './_gate/cookie.js';
import { gatePage } from './_gate/page.js';

const OPEN = new Set(['/api/gate', '/icon.png']);

export async function onRequest({ request, env, next }) {
  const url = new URL(request.url);
  if (OPEN.has(url.pathname)) return next();
  // Ohne Secret lieber geschlossen bleiben als offen
  if (env.GATE_SECRET && (await verify(request.headers.get('cookie'), env.GATE_SECRET))) return next();

  const page = request.method === 'GET' && (request.headers.get('sec-fetch-mode') === 'navigate' || (request.headers.get('accept') || '').includes('text/html'));
  if (!page) return new Response('Anmeldung erforderlich', { status: 401, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' } });
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  return new Response(gatePage(nonce), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self' https://btqpwjireatmmiyihnei.supabase.co; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    },
  });
}
