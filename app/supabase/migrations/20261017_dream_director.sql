-- Dream Director (cinematic video pipeline) + server-enforced daily reel quota.
-- ADDITIVE ONLY. Safe to run before deploying the code. Safe to re-run.

-- 1. One cinematic production per dream: Bible, storyboard, references, keyframes,
--    clips, costs and diagnostics live here as JSON (one row, resumable).
create table if not exists public.dream_productions (
  dream_id uuid primary key references public.dreams (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  generation_version text not null,                 -- e.g. 'dream-director-v2'
  tier text not null default 'free' check (tier in ('free', 'premium')),
  status text not null default 'queued' check (status in ('queued', 'processing', 'completed', 'failed')),
  stage text check (stage in ('understanding', 'storyboard', 'references', 'keyframes', 'animating', 'voice', 'editing', 'checking', 'fallback')),
  bible jsonb,            -- DreamBible (includes the untouched original transcript)
  storyboard jsonb,       -- { title, shots[], promptVersion }
  assets jsonb not null default '{}'::jsonb,   -- references / keyframes / clips with provider, model, attempts, errors
  cost_cents int not null default 0,           -- running estimate of provider spend
  renderer_type text check (renderer_type in ('cinematic_video', 'image_fallback')),
  quota_id uuid,
  error text,
  lock_until timestamptz,                      -- one worker at a time
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.dream_productions enable row level security;
-- Owners may READ their production (progress). Only the server writes it.
drop policy if exists "productions: read own" on public.dream_productions;
create policy "productions: read own" on public.dream_productions for select using (auth.uid() = user_id);
revoke insert, update, delete on public.dream_productions from anon, authenticated;
create index if not exists dream_productions_status on public.dream_productions (status, updated_at);
create index if not exists dream_productions_day on public.dream_productions (started_at);

-- 2. Which renderer and pipeline produced each finished film.
alter table public.dream_reels add column if not exists renderer_type text;
alter table public.dream_reels add column if not exists generation_version text;

-- 3. Daily reel quota. One row per reel slot used; released slots don't count.
create table if not exists public.reel_quota (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,                 -- calendar day in the app's time zone (Europe/London)
  slot int not null,
  dream_id uuid references public.dreams (id) on delete set null,
  released boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, day, slot)
);
alter table public.reel_quota enable row level security;
drop policy if exists "quota: read own" on public.reel_quota;
create policy "quota: read own" on public.reel_quota for select using (auth.uid() = user_id);
revoke insert, update, delete on public.reel_quota from anon, authenticated;

-- The plan is read from profiles (written only by the Stripe webhook), never from the browser.
create or replace function public.reel_daily_limit(p_user uuid)
returns int language plpgsql stable security definer set search_path = public as $$
declare v_premium boolean := false;
begin
  -- Premium needs the profiles table (20261012 migration). Without it everyone is free.
  if to_regclass('public.profiles') is not null then
    execute 'select exists (select 1 from public.profiles p where p.user_id = $1 and p.plan = ''premium''
             and p.subscription_status in (''active'', ''trialing''))' into v_premium using p_user;
  end if;
  return case when v_premium then 3 else 1 end;  -- Premium: 3 cinematic reels/day (see README "Costs")
end $$;

-- Claims the next reel slot for TODAY for the signed-in person, atomically.
-- Returns the quota id, or null when today's allowance is used up.
create or replace function public.claim_reel_quota(p_dream_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_day date := (now() at time zone 'Europe/London')::date;
  v_limit int;
  v_used int;
  v_id uuid;
begin
  if v_user is null then return null; end if;
  if not exists (select 1 from public.dreams d where d.id = p_dream_id and d.user_id = v_user) then return null; end if;
  perform pg_advisory_xact_lock(hashtext('reel_quota:' || v_user::text));
  -- The same dream never uses two slots.
  select id into v_id from public.reel_quota where user_id = v_user and dream_id = p_dream_id and day = v_day and not released;
  if v_id is not null then return v_id; end if;
  v_limit := public.reel_daily_limit(v_user);
  select count(*) into v_used from public.reel_quota where user_id = v_user and day = v_day and not released;
  if v_used >= v_limit then return null; end if;
  insert into public.reel_quota (user_id, day, slot, dream_id)
  values (v_user, v_day, (select coalesce(max(slot), 0) + 1 from public.reel_quota where user_id = v_user and day = v_day), p_dream_id)
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.claim_reel_quota(uuid) from public, anon;
grant execute on function public.claim_reel_quota(uuid) to authenticated;
revoke all on function public.reel_daily_limit(uuid) from public, anon, authenticated;

-- How many reels the signed-in person has left today (for the UI; the server re-checks).
create or replace function public.reels_left_today()
returns int language sql stable security definer set search_path = public as $$
  select greatest(0, public.reel_daily_limit(auth.uid()) - (
    select count(*) from public.reel_quota
    where user_id = auth.uid() and day = (now() at time zone 'Europe/London')::date and not released))::int
$$;
revoke all on function public.reels_left_today() from public, anon;
grant execute on function public.reels_left_today() to authenticated;

-- 4. New behaviour-only analytics events (names and numbers — never dream or Guru text).
do $$
declare c text;
begin
  for c in select conname from pg_constraint
    where conrelid = 'public.analytics_events'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%event%landing_view%'
  loop
    execute format('alter table public.analytics_events drop constraint %I', c);
  end loop;
end $$;
alter table public.analytics_events add constraint analytics_events_event_check check (event in (
  'landing_view', 'signup_started', 'signup_completed',
  'recording_started', 'recording_completed', 'dream_submitted',
  'dream_generation_started', 'dream_generation_completed', 'dream_generation_failed',
  'reel_render_started', 'reel_render_completed', 'reel_render_failed',
  'video_played', 'video_completed', 'video_downloaded', 'video_shared',
  'gallery_opened', 'dream_reopened', 'return_session',
  'dream_parse_completed', 'character_reference_generated', 'storyboard_completed',
  'video_clip_started', 'video_clip_completed', 'video_clip_failed', 'reel_completed',
  'reel_watched', 'reel_download_blocked_free', 'upgrade_clicked',
  'guru_opened', 'guru_voice_started', 'guru_response_completed', 'guru_chat_mode_opened'));
