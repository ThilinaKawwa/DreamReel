-- ONE-PASTE SETUP FOR A *NEW, EMPTY* SUPABASE TEST PROJECT (never the live DreamReel project).
-- Supabase → your test project → SQL Editor → New query → paste ALL of this → Run.
-- It creates the base `dreams` table (made by hand in the original project, so no migration
-- has it), then runs every migration in date order. Generated from the files in migrations/.

create table if not exists public.dreams (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  transcript text, title text,
  style text not null default 'painted',
  status text not null default 'pending',
  scenes jsonb not null default '[]'::jsonb,
  is_public boolean not null default false,
  error text
);
alter table public.dreams enable row level security;
drop policy if exists "dreams: insert own" on public.dreams;
create policy "dreams: insert own" on public.dreams for insert with check (auth.uid() = user_id);
drop policy if exists "dreams: update own" on public.dreams;
create policy "dreams: update own" on public.dreams for update using (auth.uid() = user_id);
drop policy if exists "dreams: delete own" on public.dreams;
create policy "dreams: delete own" on public.dreams for delete using (auth.uid() = user_id);
insert into storage.buckets (id, name, public) values ('reels', 'reels', true) on conflict (id) do nothing;


-- ===================== migrations/20261012_guru_and_premium.sql =====================
-- Dream Guru + Premium (monthly) + narrated / animated reels.
-- Run once in Supabase → SQL Editor (or `supabase db push`). Safe to re-run.

-- 1. Who has paid. Rows are written only by the Stripe webhook (service role),
--    so nobody can make themselves premium from the browser.
create table if not exists public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  plan text not null default 'free',              -- 'free' | 'premium'
  subscription_status text,                       -- Stripe status: active, trialing, past_due, canceled…
  stripe_customer_id text unique,
  stripe_subscription_id text,
  current_period_end timestamptz,
  guru_tradition text not null default 'blend',   -- which lens the Guru reads through
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

drop policy if exists "profiles: read own" on public.profiles;
create policy "profiles: read own" on public.profiles
  for select using (auth.uid() = user_id);

-- People may create their own row and change their tradition — nothing else.
drop policy if exists "profiles: insert own" on public.profiles;
create policy "profiles: insert own" on public.profiles
  for insert with check (auth.uid() = user_id and plan = 'free' and stripe_customer_id is null);
drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: update own" on public.profiles
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
revoke update on public.profiles from authenticated, anon;
grant update (guru_tradition, updated_at) on public.profiles to authenticated;
revoke insert on public.profiles from authenticated, anon;
grant insert (user_id, guru_tradition) on public.profiles to authenticated;

-- 2. The Guru's reading of each dream. Private: never part of the public reel page.
create table if not exists public.dream_readings (
  dream_id uuid primary key references public.dreams (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  reading text not null,          -- the full reading (markdown)
  summary text not null,          -- one or two lines shown at the end of the reel
  symbols jsonb not null default '[]'::jsonb,   -- ["sea of stars", "lighthouse", …]
  themes jsonb not null default '[]'::jsonb,    -- ["guidance", "new beginnings", …]
  emotions jsonb not null default '[]'::jsonb,  -- ["wonder", "longing", …]
  tradition text not null default 'blend',
  created_at timestamptz not null default now()
);
alter table public.dream_readings enable row level security;
drop policy if exists "readings: read own" on public.dream_readings;
create policy "readings: read own" on public.dream_readings
  for select using (auth.uid() = user_id);
drop policy if exists "readings: write own" on public.dream_readings;
create policy "readings: write own" on public.dream_readings
  for insert with check (
    auth.uid() = user_id
    and exists (select 1 from public.dreams d where d.id = dream_id and d.user_id = auth.uid())
  );
create index if not exists dream_readings_user_created on public.dream_readings (user_id, created_at desc);

-- 3. The conversation with the Guru, per dream. Private.
create table if not exists public.guru_messages (
  id uuid primary key default gen_random_uuid(),
  dream_id uuid not null references public.dreams (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  via_voice boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.guru_messages enable row level security;
drop policy if exists "guru: read own" on public.guru_messages;
create policy "guru: read own" on public.guru_messages
  for select using (auth.uid() = user_id);
drop policy if exists "guru: write own" on public.guru_messages;
create policy "guru: write own" on public.guru_messages
  for insert with check (
    auth.uid() = user_id
    and exists (select 1 from public.dreams d where d.id = dream_id and d.user_id = auth.uid())
  );
create index if not exists guru_messages_dream_created on public.guru_messages (dream_id, created_at);
create index if not exists guru_messages_user_created on public.guru_messages (user_id, created_at desc);

-- 4. Reels: narration audio + animated video live inside each scene in `scenes`
--    (audio_url, video_url, video_request_id). Track the animation as a whole here.
alter table public.dreams add column if not exists video_status text;  -- null | 'animating' | 'ready' | 'failed'

-- ===================== migrations/20261015_reels_v1.sql =====================
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
-- …except their own render starts, which the server counts to enforce the daily reel cap.
drop policy if exists "events: read own render starts" on public.analytics_events;
create policy "events: read own render starts" on public.analytics_events
  for select using (auth.uid() = user_id and event = 'reel_render_started');
-- Events are a log: nobody can edit or delete them (no update/delete policies), and the
-- timestamp is always the server's clock.
revoke update, delete on public.analytics_events from anon, authenticated;
create or replace function public.analytics_events_stamp() returns trigger
language plpgsql set search_path = public as $$ begin new.created_at := now(); return new; end $$;
drop trigger if exists analytics_events_stamp on public.analytics_events;
create trigger analytics_events_stamp before insert on public.analytics_events
  for each row execute function public.analytics_events_stamp();
create index if not exists analytics_events_event_time on public.analytics_events (event, created_at desc);
create index if not exists analytics_events_user_event_time on public.analytics_events (user_id, event, created_at desc);

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

-- ===================== migrations/20261015_privacy_lockdown.sql =====================
-- Privacy lockdown. Run AFTER the new code is live on Vercel (it reads shared dreams
-- through get_shared_dream(), created in 20261015_reels_v1.sql).
--
-- Fixes found in the audit:
--  * Anyone with the public app key could LIST every public dream, including transcripts.
--  * Anyone could LIST every file in the public `reels` bucket.

-- 1. Dreams are private by default. Sharing a link is an explicit choice in the app.
alter table public.dreams alter column is_public set default false;

-- 2. Only the owner can read their dreams directly. Shared dreams are read one at a
--    time by id through get_shared_dream(), which never returns the transcript.
drop policy if exists "dreams: read own or public" on public.dreams;
drop policy if exists "dreams: read own" on public.dreams;
create policy "dreams: read own" on public.dreams
  for select using (auth.uid() = user_id);

-- 3. Pictures stay viewable by their direct link (the bucket remains public so reels and
--    shared pages keep working), but the bucket can no longer be listed by strangers.
drop policy if exists "reels: public read" on storage.objects;
drop policy if exists "reels: owner read" on storage.objects;
create policy "reels: owner read" on storage.objects
  for select using (bucket_id = 'reels' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "reels: users update own" on storage.objects;
create policy "reels: users update own" on storage.objects
  for update using (bucket_id = 'reels' and (storage.foldername(name))[1] = auth.uid()::text);

-- 4. OPTIONAL — make every existing dream private too (their old share links stop working).
--    Recommended before inviting testers. Remove the two dashes to run it:
-- update public.dreams set is_public = false where is_public = true;

-- ===================== migrations/20261017_dream_director.sql =====================
-- Dream Director (cinematic video pipeline): private media, credits, global budget.
-- ADDITIVE ONLY — nothing existing is changed or removed. Safe to re-run.
-- Everything here is written and read by the SERVER (service role). Browsers get no
-- direct access to these tables, functions or the private media bucket.

-- 1. One cinematic production per dream. DreamBible, storyboard, every asset, per-shot
--    provider/attempts/costs and diagnostics live here as JSON (one row, resumable).
create table if not exists public.dream_productions (
  dream_id uuid primary key references public.dreams (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  env text not null check (env in ('production', 'preview', 'development')), -- the deployment that owns this job
  generation_version text not null,                 -- e.g. 'dream-director-v2'
  tier text not null default 'free' check (tier in ('free', 'premium')),
  status text not null default 'queued' check (status in ('queued', 'processing', 'completed', 'failed')),
  stage text check (stage in ('understanding', 'storyboard', 'references', 'keyframes', 'animating', 'voice', 'editing', 'checking')),
  bible jsonb,            -- DreamBible (includes the untouched original transcript)
  storyboard jsonb,       -- { title, shots[], promptVersion }
  assets jsonb not null default '{}'::jsonb,   -- references / keyframes / clips / voice: storage paths, provider, model, attempts, errors
  meta jsonb not null default '{}'::jsonb,     -- director/reference/video models, prompt versions, deployment
  cost jsonb not null default '{}'::jsonb,     -- estimated cents by part: llm, references, keyframes, video, tts, retries
  usage jsonb not null default '[]'::jsonb,    -- one line per provider call: provider, model, unit, quantity, estimated USD
  cost_cents int not null default 0,           -- running total estimate
  budget_reserved_cents int not null default 0,
  renderer_type text check (renderer_type in ('cinematic_video', 'image_fallback')),
  credit_id uuid,
  error text,
  lock_until timestamptz,                      -- one worker at a time
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.dream_productions enable row level security;
-- No policies on purpose: owners see progress through the app's server, never the raw row
-- (it holds costs and internal diagnostics).
revoke all on public.dream_productions from anon, authenticated;
create index if not exists dream_productions_status on public.dream_productions (status, updated_at);
create index if not exists dream_productions_day on public.dream_productions (started_at);

-- 2. Which renderer and pipeline produced each finished film.
alter table public.dream_reels add column if not exists renderer_type text;
alter table public.dream_reels add column if not exists generation_version text;
alter table public.dream_productions add column if not exists usage jsonb not null default '[]'::jsonb; -- for re-runs

-- 3. PRIVATE media for Dream Director: references, keyframes, clips, narration, final film.
--    No storage policies = no browser access at all. The server checks ownership and hands
--    out short-lived signed links.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('dream-media', 'dream-media', false, 104857600,
        array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'audio/wav', 'audio/mpeg'])
on conflict (id) do update set public = false;

-- 4. Cinematic reel credits. Free = a lifetime trial; Premium = a monthly allowance.
--    One credit per dream: retrying a dream never uses a second credit.
create table if not exists public.reel_credits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- set null (not cascade): deleting a dream must never hand the credit back.
  dream_id uuid unique references public.dreams (id) on delete set null,
  plan text not null check (plan in ('trial', 'premium')),
  period text not null,               -- 'lifetime' for the trial, 'YYYY-MM' (UK) for Premium
  status text not null default 'active' check (status in ('active', 'refunded')),
  refunds int not null default 0,     -- times this dream's credit was given back
  created_at timestamptz not null default now(),
  refunded_at timestamptz
);
create index if not exists reel_credits_user_period on public.reel_credits (user_id, plan, period, status);
alter table public.reel_credits enable row level security;
revoke all on public.reel_credits from anon, authenticated;

-- Takes a credit for this dream, atomically. Returns the credit id, or null when the
-- allowance is used up. The server passes the plan, limit and period it worked out from
-- trusted subscription data; browsers cannot call this.
create or replace function public.claim_reel_credit(p_user uuid, p_dream uuid, p_plan text, p_period text, p_limit int)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_status text; v_used int;
begin
  if not exists (select 1 from public.dreams d where d.id = p_dream and d.user_id = p_user) then return null; end if;
  perform pg_advisory_xact_lock(hashtext('reel_credit:' || p_user::text));
  select id, status into v_id, v_status from public.reel_credits where dream_id = p_dream;
  if v_id is not null and v_status = 'active' then return v_id; end if;   -- retry of the same dream
  select count(*) into v_used from public.reel_credits
    where user_id = p_user and plan = p_plan and period = p_period and status = 'active';
  if v_used >= p_limit then return null; end if;
  if v_id is not null then
    update public.reel_credits set status = 'active', plan = p_plan, period = p_period, refunded_at = null where id = v_id;
    return v_id;
  end if;
  insert into public.reel_credits (user_id, dream_id, plan, period) values (p_user, p_dream, p_plan, p_period)
  returning id into v_id;
  return v_id;
end $$;

-- Gives a credit back when no usable reel was produced. Capped per plan/period
-- (p_max_refunds) so deliberate fail-and-retry can't become free generations.
create or replace function public.refund_reel_credit(p_credit uuid, p_max_refunds int)
returns boolean language plpgsql security definer set search_path = public as $$
declare c public.reel_credits; v_refunds int;
begin
  select * into c from public.reel_credits where id = p_credit for update;
  if c.id is null or c.status <> 'active' then return false; end if;
  perform pg_advisory_xact_lock(hashtext('reel_credit:' || c.user_id::text));
  select coalesce(sum(refunds), 0) into v_refunds from public.reel_credits
    where user_id = c.user_id and plan = c.plan and period = c.period;
  if v_refunds >= p_max_refunds then return false; end if;
  update public.reel_credits set status = 'refunded', refunds = refunds + 1, refunded_at = now() where id = p_credit;
  return true;
end $$;
revoke all on function public.claim_reel_credit(uuid, uuid, text, text, int) from public, anon, authenticated;
revoke all on function public.refund_reel_credit(uuid, int) from public, anon, authenticated;
grant execute on function public.claim_reel_credit(uuid, uuid, text, text, int) to service_role;
grant execute on function public.refund_reel_credit(uuid, int) to service_role;

-- 5. Global daily generation budget, reserved BEFORE money is spent. The single row per
--    day is locked by each UPDATE, so concurrent productions can't all slip past the cap.
create table if not exists public.generation_budget (
  day date primary key,                 -- UTC
  reserved_cents int not null default 0, -- promised to productions in flight
  spent_cents int not null default 0,    -- estimated spend of finished work
  blocked int not null default 0,        -- productions refused because of the cap
  updated_at timestamptz not null default now()
);
alter table public.generation_budget enable row level security;
revoke all on public.generation_budget from anon, authenticated;

create or replace function public.reserve_generation_budget(p_cents int, p_cap_cents int)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_day date := (now() at time zone 'utc')::date; v_ok boolean;
begin
  insert into public.generation_budget (day) values (v_day) on conflict (day) do nothing;
  update public.generation_budget
     set reserved_cents = reserved_cents + p_cents, updated_at = now()
   where day = v_day and reserved_cents + spent_cents + p_cents <= p_cap_cents
  returning true into v_ok;
  if v_ok then return true; end if;
  update public.generation_budget set blocked = blocked + 1, updated_at = now() where day = v_day;
  return false;
end $$;

-- Turns a reservation into actual (estimated) spend. Day = the day it was reserved.
create or replace function public.settle_generation_budget(p_day date, p_reserved_cents int, p_spent_cents int)
returns void language sql security definer set search_path = public as $$
  update public.generation_budget
     set reserved_cents = greatest(0, reserved_cents - p_reserved_cents),
         spent_cents = spent_cents + p_spent_cents, updated_at = now()
   where day = p_day;
$$;
revoke all on function public.reserve_generation_budget(int, int) from public, anon, authenticated;
revoke all on function public.settle_generation_budget(date, int, int) from public, anon, authenticated;
grant execute on function public.reserve_generation_budget(int, int) to service_role;
grant execute on function public.settle_generation_budget(date, int, int) to service_role;

-- 6. New behaviour-only analytics events (names and numbers — never dream or Guru text).
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
  'guru_opened', 'guru_voice_started', 'guru_response_completed', 'guru_chat_mode_opened',
  'cinematic_failed', 'reel_budget_blocked'));

-- ===================== migrations/20261022_guru_memory.sql =====================
-- Dream Guru V2: Guru-first conversations and dream memory.
-- ADDITIVE ONLY: new tables, new columns and new policies. Nothing is dropped, renamed or
-- wiped; existing dreams, reels, credits and subscriptions are untouched. Safe to re-run.
-- Run AFTER 20261012_guru_and_premium.sql (it creates guru_messages and dream_readings).
--
-- Privacy: every table here is private to its owner (row level security), and the server
-- also filters every query by the signed-in user's id. Dream text never goes to analytics.
-- Memory is DERIVED from the user's own dreams: deleting a dream cascades through it.

-- 1. Dreams: where each dream came from ------------------------------------------------
alter table public.dreams add column if not exists source text not null default 'reel';   -- 'reel' | 'guru'
alter table public.dreams add column if not exists updated_at timestamptz not null default now();

-- 2. A conversation with Orin. Voice and text share it; it may or may not hold a dream ---
create table if not exists public.guru_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  dream_id uuid references public.dreams (id) on delete set null,   -- the dream being captured / discussed
  capture_open boolean not null default false,    -- the dreamer is still telling the dream
  clarifications int not null default 0,          -- follow-up questions asked while capturing
  visualize_offered boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.guru_conversations enable row level security;
drop policy if exists "conversations: read own" on public.guru_conversations;
create policy "conversations: read own" on public.guru_conversations
  for select using (auth.uid() = user_id);
drop policy if exists "conversations: insert own" on public.guru_conversations;
create policy "conversations: insert own" on public.guru_conversations
  for insert with check (
    auth.uid() = user_id
    and (dream_id is null or exists (select 1 from public.dreams d where d.id = dream_id and d.user_id = auth.uid()))
  );
drop policy if exists "conversations: update own" on public.guru_conversations;
create policy "conversations: update own" on public.guru_conversations
  for update using (auth.uid() = user_id) with check (
    auth.uid() = user_id
    and (dream_id is null or exists (select 1 from public.dreams d where d.id = dream_id and d.user_id = auth.uid()))
  );
drop policy if exists "conversations: delete own" on public.guru_conversations;
create policy "conversations: delete own" on public.guru_conversations
  for delete using (auth.uid() = user_id);
create index if not exists guru_conversations_user_updated on public.guru_conversations (user_id, updated_at desc);

-- 3. Guru messages now belong to a conversation; the dream is optional -------------------
alter table public.guru_messages add column if not exists conversation_id uuid references public.guru_conversations (id) on delete cascade;
alter table public.guru_messages add column if not exists intent text;
alter table public.guru_messages add column if not exists memory_refs uuid[] not null default '{}';  -- earlier dreams Orin cited
alter table public.guru_messages alter column dream_id drop not null;   -- relaxes a rule; no data changes
drop policy if exists "guru: write own" on public.guru_messages;
create policy "guru: write own" on public.guru_messages
  for insert with check (
    auth.uid() = user_id
    and (dream_id is null or exists (select 1 from public.dreams d where d.id = dream_id and d.user_id = auth.uid()))
    and (conversation_id is null or exists (select 1 from public.guru_conversations c where c.id = conversation_id and c.user_id = auth.uid()))
  );
create index if not exists guru_messages_conversation_created on public.guru_messages (conversation_id, created_at);

-- 4. Level 1 — one structured memory per dream ----------------------------------------
-- The original words stay in dreams.transcript, untouched. This row is rebuilt whenever
-- the dream changes (source_hash), and disappears with the dream.
create table if not exists public.dream_memories (
  dream_id uuid primary key references public.dreams (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'ready', 'failed')),
  memory_version text,
  source_hash text,                 -- what it was built from; a mismatch means rebuild
  attempts int not null default 0,
  error text,                       -- short internal reason, never dream text
  dream_at timestamptz not null default now(),  -- when the dream was recorded (copy of dreams.created_at)
  title text,
  summary text,
  cleaned_text text,
  dream_type text,
  emotions text[] not null default '{}',
  themes text[] not null default '{}',
  people jsonb not null default '[]'::jsonb,
  places jsonb not null default '[]'::jsonb,
  objects jsonb not null default '[]'::jsonb,
  creatures jsonb not null default '[]'::jsonb,
  events jsonb not null default '[]'::jsonb,
  details jsonb not null default '[]'::jsonb,      -- short phrases the dreamer used
  follow_ups jsonb not null default '[]'::jsonb,   -- [{question, answer}] from the conversation
  reflection text,                                 -- Orin's reflection when the dream was captured
  search tsvector generated always as (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(cleaned_text, ''))
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.dream_memories enable row level security;
drop policy if exists "memories: read own" on public.dream_memories;
create policy "memories: read own" on public.dream_memories for select using (auth.uid() = user_id);
drop policy if exists "memories: insert own" on public.dream_memories;
create policy "memories: insert own" on public.dream_memories for insert with check (
  auth.uid() = user_id and exists (select 1 from public.dreams d where d.id = dream_id and d.user_id = auth.uid()));
drop policy if exists "memories: update own" on public.dream_memories;
create policy "memories: update own" on public.dream_memories for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "memories: delete own" on public.dream_memories;
create policy "memories: delete own" on public.dream_memories for delete using (auth.uid() = user_id);
create index if not exists dream_memories_user_time on public.dream_memories (user_id, dream_at desc);
create index if not exists dream_memories_search on public.dream_memories using gin (search);

-- 5. Level 2 — recurring people, places, objects and creatures --------------------------
-- An entity is a label; its appearances are rows in dream_entity_occurrences, which vanish
-- with their dream. Counts are never stored, so they can't go stale.
create table if not exists public.dream_entities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  entity_type text not null check (entity_type in ('person', 'place', 'object', 'creature')),
  norm_key text not null,           -- e.g. 'brother', 'train station'
  label text not null,              -- how Orin names it, e.g. 'your brother'
  aliases text[] not null default '{}',
  specific boolean not null default false,  -- 'my grandmother's house' (one place) vs 'a station' (maybe many)
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, entity_type, norm_key)
);
alter table public.dream_entities enable row level security;
drop policy if exists "entities: read own" on public.dream_entities;
create policy "entities: read own" on public.dream_entities for select using (auth.uid() = user_id);
drop policy if exists "entities: insert own" on public.dream_entities;
create policy "entities: insert own" on public.dream_entities for insert with check (auth.uid() = user_id);
drop policy if exists "entities: update own" on public.dream_entities;
create policy "entities: update own" on public.dream_entities for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "entities: delete own" on public.dream_entities;
create policy "entities: delete own" on public.dream_entities for delete using (auth.uid() = user_id);

create table if not exists public.dream_entity_occurrences (
  entity_id uuid not null references public.dream_entities (id) on delete cascade,
  dream_id uuid not null references public.dreams (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  mention text,                     -- the words used in this dream, e.g. 'my older brother'
  emotion text,                     -- feeling around it in this dream
  confidence real not null default 0.7,   -- how sure we are this is the SAME entity
  created_at timestamptz not null default now(),
  primary key (entity_id, dream_id)
);
alter table public.dream_entity_occurrences enable row level security;
drop policy if exists "occurrences: read own" on public.dream_entity_occurrences;
create policy "occurrences: read own" on public.dream_entity_occurrences for select using (auth.uid() = user_id);
drop policy if exists "occurrences: insert own" on public.dream_entity_occurrences;
create policy "occurrences: insert own" on public.dream_entity_occurrences for insert with check (
  auth.uid() = user_id
  and exists (select 1 from public.dreams d where d.id = dream_id and d.user_id = auth.uid())
  and exists (select 1 from public.dream_entities e where e.id = entity_id and e.user_id = auth.uid()));
drop policy if exists "occurrences: delete own" on public.dream_entity_occurrences;
create policy "occurrences: delete own" on public.dream_entity_occurrences for delete using (auth.uid() = user_id);
create index if not exists dream_entity_occurrences_dream on public.dream_entity_occurrences (dream_id);
create index if not exists dream_entity_occurrences_user on public.dream_entity_occurrences (user_id);

-- Live counts per entity (reads as the signed-in user: RLS applies through security_invoker).
create or replace view public.dream_entity_stats with (security_invoker = true) as
  select e.id, e.user_id, e.entity_type, e.norm_key, e.label, e.aliases, e.specific, e.attributes,
         count(o.dream_id)::int as appearances,
         min(d.created_at) as first_seen,
         max(d.created_at) as last_seen,
         coalesce(array_agg(o.dream_id order by d.created_at desc) filter (where o.dream_id is not null), '{}') as dream_ids,
         coalesce(array_agg(o.emotion) filter (where o.emotion is not null), '{}') as emotions,
         coalesce(avg(o.confidence), 0)::real as confidence
  from public.dream_entities e
  left join public.dream_entity_occurrences o on o.entity_id = e.id
  left join public.dreams d on d.id = o.dream_id
  group by e.id;
revoke all on public.dream_entity_stats from anon;

-- 6. Related / possibly-recurring dreams (scored pairs; vanish with either dream) --------
create table if not exists public.dream_links (
  user_id uuid not null references auth.users (id) on delete cascade,
  dream_a uuid not null references public.dreams (id) on delete cascade,
  dream_b uuid not null references public.dreams (id) on delete cascade,
  score real not null,
  reasons jsonb not null default '[]'::jsonb,   -- e.g. [{"kind":"person","label":"your brother"}]
  created_at timestamptz not null default now(),
  primary key (dream_a, dream_b),
  check (dream_a < dream_b)
);
alter table public.dream_links enable row level security;
drop policy if exists "links: read own" on public.dream_links;
create policy "links: read own" on public.dream_links for select using (auth.uid() = user_id);
drop policy if exists "links: insert own" on public.dream_links;
create policy "links: insert own" on public.dream_links for insert with check (
  auth.uid() = user_id
  and exists (select 1 from public.dreams d where d.id = dream_a and d.user_id = auth.uid())
  and exists (select 1 from public.dreams d where d.id = dream_b and d.user_id = auth.uid()));
drop policy if exists "links: update own" on public.dream_links;
create policy "links: update own" on public.dream_links for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "links: delete own" on public.dream_links;
create policy "links: delete own" on public.dream_links for delete using (auth.uid() = user_id);
create index if not exists dream_links_b on public.dream_links (dream_b);

-- 7. Level 3 — pattern observations. A cache rebuilt from levels 1–2 after every change ---
create table if not exists public.dream_patterns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  pattern_key text not null,         -- stable id, e.g. 'entity:place:train station'
  pattern_type text not null,        -- recurring_entity | recurring_theme | entity_emotion | emotion_trend
  description text not null,         -- careful wording, built from counts — never a diagnosis
  dream_ids uuid[] not null default '{}',
  strength int not null default 0,   -- number of supporting dreams
  confidence real not null default 0,
  first_detected timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, pattern_key)
);
alter table public.dream_patterns enable row level security;
drop policy if exists "patterns: read own" on public.dream_patterns;
create policy "patterns: read own" on public.dream_patterns for select using (auth.uid() = user_id);
drop policy if exists "patterns: insert own" on public.dream_patterns;
create policy "patterns: insert own" on public.dream_patterns for insert with check (auth.uid() = user_id);
drop policy if exists "patterns: update own" on public.dream_patterns;
create policy "patterns: update own" on public.dream_patterns for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "patterns: delete own" on public.dream_patterns;
create policy "patterns: delete own" on public.dream_patterns for delete using (auth.uid() = user_id);

-- 8. Guru cost metadata (numbers only — never text). People can add rows, never read them.
create table if not exists public.guru_usage (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null check (kind in ('transcription', 'llm', 'tts', 'memory')),
  model text,
  quantity numeric(12, 4) not null default 0,
  unit text,
  est_usd numeric(12, 6) not null default 0
);
alter table public.guru_usage enable row level security;
drop policy if exists "usage: insert own" on public.guru_usage;
create policy "usage: insert own" on public.guru_usage for insert with check (auth.uid() = user_id);
revoke update, delete on public.guru_usage from anon, authenticated;
create index if not exists guru_usage_time on public.guru_usage (created_at desc);
create or replace view public.guru_cost_daily with (security_invoker = true) as
  select date_trunc('day', created_at)::date as day, kind, model, count(*) as calls,
         round(sum(est_usd), 4) as est_usd, count(distinct user_id) as people
  from public.guru_usage group by 1, 2, 3 order by 1 desc, 2;
revoke all on public.guru_cost_daily from anon, authenticated;

-- 9. New behaviour-only analytics events (names and numbers — never dream or Guru text) --
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
  'guru_opened', 'guru_voice_started', 'guru_response_completed', 'guru_chat_mode_opened',
  'cinematic_failed', 'reel_budget_blocked',
  -- Dream Guru V2
  'guru_voice_completed', 'guru_text_opened', 'dream_capture_started', 'dream_saved',
  'clarification_asked', 'dream_recalled', 'dream_search_used', 'related_dream_opened',
  'insights_opened', 'visualize_dream_clicked', 'visualize_offered', 'guru_limit_reached',
  'onboarding_completed', 'dream_deleted', 'dream_edited', 'memory_built', 'memory_failed'));
