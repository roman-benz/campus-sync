// Zugangsschutz für die ganze Website: Ohne gültige Passkey-Sitzung gibt es nur die Login-Seite.
// Gilt für alles (App-Dateien, Proxy, Service Worker) – außer Login, Einladungen und dem Icon.
import { getSession, MAIN_HOST } from './_auth/lib.js';
import { loginPage, securityHeaders, newNonce } from './_auth/pages.js';

const OPEN = (p) => p === '/icon.png' || p === '/einladung' || p.startsWith('/api/auth/');

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  // Passkeys gelten nur für die Hauptdomain: *.pages.dev dorthin umleiten
  if (url.hostname.endsWith('.pages.dev')) return Response.redirect(`https://${MAIN_HOST}${url.pathname}${url.search}`, 301);
  if (OPEN(url.pathname)) return next();

  const session = await getSession(request, env).catch(() => null);
  if (session) {
    context.data.session = session;
    return next();
  }
  const navigate = request.method === 'GET' && (request.headers.get('sec-fetch-mode') === 'navigate' || (request.headers.get('accept') || '').includes('text/html'));
  if (!navigate) return new Response('Anmeldung erforderlich', { status: 401, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' } });
  const nonce = newNonce();
  return new Response(loginPage(nonce), { headers: securityHeaders(nonce) });
}
