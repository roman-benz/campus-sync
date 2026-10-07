-- Chadoodle-Konto: Identität = Moodle-Seite + Moodle-User-ID. Kursdateien und Moodle-Tokens werden nie gespeichert.
-- Angewendet auf das Supabase-Projekt „Chadoodle“ (btqpwjireatmmiyihnei).

-- Nur Konten, die die Edge Function „account“ über einen Moodle-Login angelegt hat (app_metadata
-- kann nur der Server setzen). Schützt vor Konten über die normale E-Mail-Registrierung.
create or replace function public.is_moodle_user()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'moodle') = 'true', false)
$$;

create table public.moodle_identities (
  site_url text not null,
  moodle_userid bigint not null,
  user_id uuid not null unique references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  last_login timestamptz not null default now(),
  primary key (site_url, moodle_userid)
);
alter table public.moodle_identities enable row level security;
create policy "Eigene Moodle-Identität lesen" on public.moodle_identities
  for select to authenticated using (user_id = (select auth.uid()));

-- Einstellungen: { schlüssel: { "v": wert, "t": änderungszeit_ms } } – pro Schlüssel gewinnt die neuere Änderung
create table public.user_settings (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb check (pg_column_size(data) < 262144),
  updated_at timestamptz not null default now()
);
alter table public.user_settings enable row level security;
create policy "Eigene Einstellungen lesen" on public.user_settings
  for select to authenticated using (user_id = (select auth.uid()) and (select public.is_moodle_user()));
create policy "Eigene Einstellungen anlegen" on public.user_settings
  for insert to authenticated with check (user_id = (select auth.uid()) and (select public.is_moodle_user()));
create policy "Eigene Einstellungen ändern" on public.user_settings
  for update to authenticated using (user_id = (select auth.uid()) and (select public.is_moodle_user()))
  with check (user_id = (select auth.uid()));

-- Optional synchronisierter Claude-API-Key (nur für den Besitzer lesbar)
create table public.user_secrets (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  anthropic_key text check (anthropic_key is null or length(anthropic_key) < 512),
  updated_ms bigint not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.user_secrets enable row level security;
create policy "Eigene Geheimnisse lesen" on public.user_secrets
  for select to authenticated using (user_id = (select auth.uid()) and (select public.is_moodle_user()));
create policy "Eigene Geheimnisse anlegen" on public.user_secrets
  for insert to authenticated with check (user_id = (select auth.uid()) and (select public.is_moodle_user()));
create policy "Eigene Geheimnisse ändern" on public.user_secrets
  for update to authenticated using (user_id = (select auth.uid()) and (select public.is_moodle_user()))
  with check (user_id = (select auth.uid()));
create policy "Eigene Geheimnisse löschen" on public.user_secrets
  for delete to authenticated using (user_id = (select auth.uid()));

-- Über Chadoodle aufgegebene Mensa-Bestellungen
create table public.mensa_orders (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  order_no text not null check (length(order_no) between 1 and 64),
  data jsonb not null check (pg_column_size(data) < 16384),
  created_at timestamptz not null default now(),
  primary key (user_id, order_no)
);
alter table public.mensa_orders enable row level security;
create policy "Eigene Bestellungen lesen" on public.mensa_orders
  for select to authenticated using (user_id = (select auth.uid()) and (select public.is_moodle_user()));
create policy "Eigene Bestellungen anlegen" on public.mensa_orders
  for insert to authenticated with check (user_id = (select auth.uid()) and (select public.is_moodle_user()));

-- Einstellungen atomar zusammenführen (zwei Geräte gleichzeitig dürfen sich nichts überschreiben)
create or replace function public.merge_settings(patch jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  cur jsonb;
  k text;
  v jsonb;
begin
  if uid is null or not public.is_moodle_user() then
    raise exception 'nicht angemeldet' using errcode = '42501';
  end if;
  if jsonb_typeof(patch) <> 'object' then
    raise exception 'patch muss ein Objekt sein' using errcode = '22023';
  end if;
  insert into public.user_settings (user_id) values (uid) on conflict (user_id) do nothing;
  select data into cur from public.user_settings where user_id = uid for update;
  for k, v in select * from jsonb_each(patch) loop
    if jsonb_typeof(v) = 'object' and v ? 't'
       and (cur -> k is null or coalesce((cur -> k ->> 't')::bigint, 0) < (v ->> 't')::bigint) then
      cur := jsonb_set(cur, array[k], v, true);
    end if;
  end loop;
  update public.user_settings set data = cur, updated_at = now() where user_id = uid;
  return cur;
end
$$;
revoke execute on function public.merge_settings(jsonb) from public, anon;
grant execute on function public.merge_settings(jsonb) to authenticated;

-- Live-Abgleich zwischen Geräten
alter publication supabase_realtime add table public.user_settings, public.user_secrets, public.mensa_orders;
