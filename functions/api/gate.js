// POST   /api/gate  { access_token }  → prüft die Supabase-Sitzung und die Freigabe, setzt das Zugangs-Cookie
// DELETE /api/gate                     → Zugangs-Cookie löschen (abmelden)
import { sign, setCookie, MAX_AGE, SUPABASE_URL, SUPABASE_KEY } from '../_gate/cookie.js';

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

export async function onRequestPost({ request, env }) {
  if (!env.GATE_SECRET) return json({ error: 'Zugang ist nicht eingerichtet.' }, 503);
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return json({ error: 'Nicht erlaubt' }, 403);
  const { access_token: token } = await request.json().catch(() => ({}));
  if (!token || typeof token !== 'string') return json({ error: 'Anmeldung fehlt.' }, 400);
  // Supabase prüft das Token und liefert den aktuellen Stand des Kontos (auch die Freigabe)
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` } });
  if (!res.ok) return json({ error: 'Anmeldung abgelaufen – bitte erneut anmelden.' }, 401);
  const user = await res.json();
  if (!user.app_metadata || user.app_metadata.web_access !== true) {
    return json({ error: 'Dieses Konto ist für Chadoodle im Browser (noch) nicht freigeschaltet.' }, 403);
  }
  const value = await sign({ sub: user.id, exp: Math.floor(Date.now() / 1000) + MAX_AGE }, env.GATE_SECRET);
  return json({ ok: true }, 200, { 'Set-Cookie': setCookie(value) });
}

export async function onRequestDelete() {
  return json({ ok: true }, 200, { 'Set-Cookie': setCookie('', 0) });
}
