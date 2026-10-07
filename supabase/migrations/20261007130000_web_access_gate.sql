-- Zugang zur Website chadoodle.romanbenz.com nur für freigegebene E-Mail-Adressen.
-- Wer auf der Liste steht, bekommt bei der Registrierung app_metadata.web_access = true
-- (app_metadata kann nur der Server setzen; die Pages Function prüft diesen Wert).
create table public.web_access_emails (
  email text primary key check (email = lower(email)),
  created_at timestamptz not null default now()
);
alter table public.web_access_emails enable row level security;
-- Keine Policies: nur über das Dashboard/SQL pflegbar

insert into public.web_access_emails (email) values ('benzroman04@gmail.com');

create or replace function public.grant_web_access()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.web_access_emails w where w.email = lower(new.email)) then
    new.raw_app_meta_data := coalesce(new.raw_app_meta_data, '{}'::jsonb) || '{"web_access": true}'::jsonb;
  end if;
  return new;
end
$$;
revoke execute on function public.grant_web_access() from public, anon, authenticated;

create trigger grant_web_access
  before insert or update of email on auth.users
  for each row execute function public.grant_web_access();
