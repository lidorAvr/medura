-- Minimal emulation of a fresh Supabase project, loaded BEFORE supabase/schema.sql in tests.
--
-- It recreates the parts of Supabase that the schema relies on:
--   * roles anon / authenticated / service_role (NOLOGIN; the test user may SET ROLE to them)
--   * auth.uid() reading the JWT "sub" claim exactly like Supabase does
--   * the supabase_realtime publication (empty)
--   * Supabase's permissive default privileges on schema public (everything granted to
--     anon/authenticated/service_role), so the tests prove that RLS and the schema's own
--     revokes block access — not missing grants.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

grant anon, authenticated, service_role to current_user;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create or replace function auth.uid() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
grant execute on function auth.uid() to anon, authenticated, service_role;

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;

alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
