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
