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
