// Chadoodle-Konto (Supabase Edge Function „account“)
//
// POST /account/login   { siteUrl, token }  → Sitzung für das Konto dieser Moodle-Identität
// POST /account/delete  (Authorization: Bearer <Sitzung>) → Konto und alle synchronisierten Daten löschen
//
// Die Identität ist „Moodle-Seite + Moodle-User-ID“. Das Moodle-Token beweist sie: Die Funktion fragt
// damit einmal core_webservice_get_site_info ab und vergisst es danach – gespeichert wird es nie.
// Die Seite zählt so, wie sie aufgerufen wurde (nicht, was sie über sich behauptet): Eine fremde
// Moodle-Seite kann daher nur Konten unter ihrer eigenen Adresse erzeugen.
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const ORIGINS = ['https://chadoodle.romanbenz.com', 'http://localhost:8788'];

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

function cors(req: Request) {
  const origin = req.headers.get('origin') || '';
  return {
    'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'Content-Type': 'application/json' } });

// Wie normalizeSite in src/main/moodle.js, zusätzlich: nur https, keine IP-Adressen/localhost
function normalizeSite(input: string): string {
  let s = String(input || '').trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  const u = new URL(s);
  if (u.protocol !== 'https:' || u.username || u.password || u.port) throw new Error('Nur https-Moodle-Seiten werden unterstützt.');
  const host = u.hostname.toLowerCase();
  if (!host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':') || host.endsWith('.local') || host === 'localhost') {
    throw new Error('Ungültige Moodle-Adresse.');
  }
  return `https://${host}${u.pathname.replace(/\/+$/, '')}`;
}

async function sha256Hex(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function login(req: Request) {
  const { siteUrl, token } = await req.json().catch(() => ({}));
  if (!siteUrl || !token || typeof token !== 'string' || token.length > 200) return json(req, { error: 'siteUrl und token fehlen' }, 400);
  let site: string;
  try {
    site = normalizeSite(siteUrl);
  } catch (e) {
    return json(req, { error: (e as Error).message }, 400);
  }

  // Token bei Moodle prüfen
  let info: { userid?: number; exception?: string; message?: string };
  try {
    const res = await fetch(`${site}/webservice/rest/server.php?moodlewsrestformat=json&wsfunction=core_webservice_get_site_info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ wstoken: token, wsfunction: 'core_webservice_get_site_info' }),
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    info = await res.json();
  } catch {
    return json(req, { error: 'Moodle-Seite nicht erreichbar.' }, 502);
  }
  if (!info || info.exception || !Number.isInteger(info.userid) || info.userid! <= 0) {
    return json(req, { error: 'Moodle hat die Anmeldung nicht bestätigt.' }, 401);
  }
  const moodleUserid = info.userid!;

  // Konto finden oder anlegen. Die E-Mail ist nur ein interner Schlüssel (kein Postfach, keine Mails).
  const { data: ident } = await admin.from('moodle_identities').select('user_id').eq('site_url', site).eq('moodle_userid', moodleUserid).maybeSingle();
  const email = `m-${(await sha256Hex(`${site}#${moodleUserid}`)).slice(0, 32)}@users.chadoodle.romanbenz.com`;
  let userId = ident?.user_id as string | undefined;
  if (!userId) {
    const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true, app_metadata: { moodle: 'true' } });
    if (error && !/already/i.test(error.message)) return json(req, { error: 'Konto konnte nicht angelegt werden.' }, 500);
    userId = data?.user?.id;
    if (!userId) {
      // Halb angelegt (z. B. abgebrochen): vorhandenen Nutzer zur E-Mail suchen
      const { data: link } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
      userId = link?.user?.id;
    }
    if (!userId) return json(req, { error: 'Konto konnte nicht angelegt werden.' }, 500);
    const { error: e2 } = await admin.from('moodle_identities').upsert({ site_url: site, moodle_userid: moodleUserid, user_id: userId });
    if (e2) return json(req, { error: 'Konto konnte nicht verknüpft werden.' }, 500);
  } else {
    await admin.from('moodle_identities').update({ last_login: new Date().toISOString() }).eq('user_id', userId);
  }

  // Sitzung ausstellen: Einmal-Link erzeugen (ohne Versand) und direkt einlösen
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (linkErr || !link?.properties?.hashed_token) return json(req, { error: 'Anmeldung fehlgeschlagen, bitte gleich nochmal versuchen.' }, 500);
  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: ses, error: otpErr } = await anon.auth.verifyOtp({ type: 'magiclink', token_hash: link.properties.hashed_token });
  if (otpErr || !ses.session) return json(req, { error: 'Anmeldung fehlgeschlagen, bitte gleich nochmal versuchen.' }, 500);
  return json(req, { access_token: ses.session.access_token, refresh_token: ses.session.refresh_token, user_id: userId });
}

async function remove(req: Request) {
  const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data.user) return json(req, { error: 'Nicht angemeldet' }, 401);
  // Löscht über ON DELETE CASCADE auch Einstellungen, Key, Bestellungen und die Moodle-Verknüpfung
  const { error: delErr } = await admin.auth.admin.deleteUser(data.user.id);
  if (delErr) return json(req, { error: 'Löschen fehlgeschlagen' }, 500);
  return json(req, { ok: true });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== 'POST') return json(req, { error: 'Nur POST' }, 405);
  const path = new URL(req.url).pathname;
  if (path.endsWith('/login')) return login(req);
  if (path.endsWith('/delete')) return remove(req);
  return json(req, { error: 'Unbekannter Aufruf' }, 404);
});
