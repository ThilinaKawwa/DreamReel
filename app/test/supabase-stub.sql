-- Minimal stand-ins for the parts of Supabase our migrations rely on (roles, auth.uid(),
-- storage), plus the live `dreams` table as it exists in production (2026-10-22), which no
-- migration in this repo creates. Used by test/memory-sql.mjs and test/memory-integration.mjs.
-- Roles are shared by the whole Postgres server, so create them only once.
do $$ begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (id uuid primary key);
-- Like Supabase: the signed-in user's id from the request's JWT (either setting style).
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub'
  )::uuid
$$;
grant execute on function auth.uid() to anon, authenticated, service_role;

create schema storage;
grant usage on schema storage to anon, authenticated, service_role;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
create function storage.foldername(name text) returns text[] language sql as $$ select string_to_array(name, '/') $$;

create table public.dreams (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  transcript text, title text,
  style text not null default 'painted',
  status text not null default 'pending',
  scenes jsonb not null default '[]'::jsonb,
  is_public boolean not null default true,
  error text
);
alter table public.dreams enable row level security;
create policy "dreams: read own or public" on public.dreams for select using (is_public or auth.uid() = user_id);
create policy "dreams: insert own" on public.dreams for insert with check (auth.uid() = user_id);
create policy "dreams: update own" on public.dreams for update using (auth.uid() = user_id);
create policy "dreams: delete own" on public.dreams for delete using (auth.uid() = user_id);
