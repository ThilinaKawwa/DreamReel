-- Dream Reel films (Shareable Video V1) + funnel analytics + safe shared-dream reads.
-- ADDITIVE ONLY: adds new tables, a private bucket and a function. Nothing existing
-- changes, so it is safe to run BEFORE deploying the new code. Safe to re-run.

-- 1. One finished film per dream ---------------------------------------------------
create table if not exists public.dream_reels (
  dream_id uuid primary key references public.dreams (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'completed', 'failed')),   -- no row = not started
  stage text check (stage in ('writing', 'voice', 'animating', 'finishing', 'saving')),
  narration jsonb,                 -- { lines: [...], mood, source, voiced: [seconds|null] }
  soundtrack text,                 -- id of the music track, e.g. 'dreamy'
  video_path text,                 -- dream-videos/<user>/<dream>/reel.mp4
  poster_path text,
  duration_seconds numeric(6, 1),
  size_bytes bigint,
  width int,
  height int,
  error text,                      -- friendly message only; details stay in server logs
  attempts int not null default 0,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.dream_reels enable row level security;

drop policy if exists "reels: read own" on public.dream_reels;
create policy "reels: read own" on public.dream_reels
  for select using (auth.uid() = user_id);
drop policy if exists "reels: insert own" on public.dream_reels;
create policy "reels: insert own" on public.dream_reels
  for insert with check (
    auth.uid() = user_id
    and exists (select 1 from public.dreams d where d.id = dream_id and d.user_id = auth.uid())
  );
drop policy if exists "reels: update own" on public.dream_reels;
create policy "reels: update own" on public.dream_reels
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create index if not exists dream_reels_user_started on public.dream_reels (user_id, started_at desc);

-- 2. Private storage for films, posters and narration audio -------------------------
-- Not public: files are only reachable by their owner, through short-lived signed links.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('dream-videos', 'dream-videos', false, 62914560, array['video/mp4', 'image/jpeg', 'audio/wav'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "dream-videos: owner read" on storage.objects;
create policy "dream-videos: owner read" on storage.objects
  for select using (bucket_id = 'dream-videos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "dream-videos: owner write" on storage.objects;
create policy "dream-videos: owner write" on storage.objects
  for insert with check (bucket_id = 'dream-videos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "dream-videos: owner update" on storage.objects;
create policy "dream-videos: owner update" on storage.objects
  for update using (bucket_id = 'dream-videos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "dream-videos: owner delete" on storage.objects;
create policy "dream-videos: owner delete" on storage.objects
  for delete using (bucket_id = 'dream-videos' and (storage.foldername(name))[1] = auth.uid()::text);

-- 3. Funnel analytics: behaviour only, never dream text -----------------------------
create table if not exists public.analytics_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  event text not null check (event in (
    'landing_view', 'signup_started', 'signup_completed',
    'recording_started', 'recording_completed', 'dream_submitted',
    'dream_generation_started', 'dream_generation_completed', 'dream_generation_failed',
    'reel_render_started', 'reel_render_completed', 'reel_render_failed',
    'video_played', 'video_completed', 'video_downloaded', 'video_shared',
    'gallery_opened', 'dream_reopened', 'return_session')),
  props jsonb not null default '{}'::jsonb check (octet_length(props::text) <= 600),
  source text not null default 'web' check (source in ('web', 'server'))
);
alter table public.analytics_events enable row level security;
-- People can add their own events but never read anyone's (you read them in the dashboard).
drop policy if exists "events: insert own" on public.analytics_events;
create policy "events: insert own" on public.analytics_events
  for insert with check (auth.uid() = user_id);
create index if not exists analytics_events_event_time on public.analytics_events (event, created_at desc);

-- 4. Reading a dream someone chose to share — by its id only, never as a list ---------
create or replace function public.get_shared_dream(p_id uuid)
returns table (id uuid, title text, scenes jsonb, style text, created_at timestamptz, status text)
language sql stable security definer set search_path = public
as $$
  select d.id, d.title, d.scenes, d.style, d.created_at, d.status
  from public.dreams d
  where d.id = p_id and d.is_public = true and d.status = 'ready'
$$;
revoke all on function public.get_shared_dream(uuid) from public;
grant execute on function public.get_shared_dream(uuid) to anon, authenticated;

-- 5. Handy funnel view for you (Supabase → SQL Editor: select * from funnel_daily)
create or replace view public.funnel_daily with (security_invoker = true) as
  select date_trunc('day', created_at)::date as day, event, count(*) as events, count(distinct user_id) as people
  from public.analytics_events group by 1, 2 order by 1 desc, 2;
revoke all on public.funnel_daily from anon, authenticated;
