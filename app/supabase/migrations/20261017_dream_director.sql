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
