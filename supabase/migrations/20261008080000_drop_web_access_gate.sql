-- Der Website-Login läuft jetzt über Passkeys (Cloudflare D1, siehe d1/migrations), nicht mehr über Supabase Auth.
drop trigger if exists grant_web_access on auth.users;
drop function if exists public.grant_web_access();
drop table if exists public.web_access_emails;
