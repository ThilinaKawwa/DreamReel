// npm run test:sql — runs the REAL migration file on a local Postgres (PGlite) with stub Supabase schemas,
// then exercises credits, refunds, budget and privileges.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
const db = new PGlite();
const q = (s, p) => db.query(s, p);
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema auth; create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create schema storage; create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table public.dreams (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id), transcript text, style text, status text, is_public boolean default false);
  create table public.dream_reels (dream_id uuid primary key);
  create table public.analytics_events (id bigint generated always as identity primary key, event text not null check (event in ('landing_view','x')));
`);
await db.exec(readFileSync(new URL('../supabase/migrations/20261017_dream_director.sql', import.meta.url), 'utf8'));
await db.exec(readFileSync(new URL('../supabase/migrations/20261017_dream_director.sql', import.meta.url), 'utf8')); // re-runnable
const u = '11111111-1111-4111-8111-111111111111', other = '99999999-9999-4999-8999-999999999999';
await q(`insert into auth.users values ($1), ($2)`, [u, other]);
const dream = async (owner = u) => (await q(`insert into public.dreams (user_id, status) values ($1,'pending') returning id`, [owner])).rows[0].id;
const claim = async (d, plan = 'trial', period = 'lifetime', limit = 1, user = u) => (await q(`select public.claim_reel_credit($1,$2,$3,$4,$5) as id`, [user, d, plan, period, limit])).rows[0].id;
const refund = async (c, max = 2) => (await q(`select public.refund_reel_credit($1,$2) as ok`, [c, max])).rows[0].ok;
const out = {}; const check = (k, v) => { out[k] = v; if (!v) out.FAIL = true; };

const d1 = await dream(), d2 = await dream(), d3 = await dream(), d4 = await dream();
const c1 = await claim(d1);
check('trial: first claim ok', !!c1);
check('trial: retry of same dream reuses credit', (await claim(d1)) === c1);
check('trial: second dream blocked (1 lifetime)', (await claim(d2)) === null);
check('cannot claim for someone else\'s dream', (await claim(d2, 'trial', 'lifetime', 1, other)) === null);
check('refund #1 ok', await refund(c1));
const c2 = await claim(d2);
check('after refund, a new trial claim works', !!c2);
check('refund #2 ok', await refund(c2));
const c3 = await claim(d3);
check('third claim ok', !!c3);
check('refund #3 refused (cap 2)', (await refund(c3)) === false);
check('fourth dream blocked', (await claim(d4)) === null);
await q(`delete from public.dreams where id = $1`, [d3]);
check('deleting the dream does not return the credit', (await claim(d4)) === null);
const keep = (await q(`select count(*)::int n from public.reel_credits where id=$1 and status='active'`, [c3])).rows[0].n;
check('credit row survives dream deletion', keep === 1);
// premium monthly
const p = []; for (let i = 0; i < 5; i++) p.push(await dream());
const got = []; for (const d of p) got.push(await claim(d, 'premium', '2026-10', 4));
check('premium: 4 per month, 5th blocked', got.slice(0, 4).every(Boolean) && got[4] === null);
check('premium: new month allowed', !!(await claim(p[4], 'premium', '2026-11', 4)));
// concurrency: 10 parallel claims on fresh user (PGlite serialises, logic must still hold)
const u2 = '22222222-2222-4222-8222-222222222222'; await q(`insert into auth.users values ($1)`, [u2]);
const many = []; for (let i = 0; i < 10; i++) many.push(await dream(u2));
const res = await Promise.all(many.map((d) => claim(d, 'trial', 'lifetime', 1, u2)));
check('10 simultaneous trial claims → exactly 1 succeeds', res.filter(Boolean).length === 1);
// budget
check('budget reserve within cap', (await q(`select public.reserve_generation_budget(2000, 2500) ok`)).rows[0].ok === true);
check('budget reserve over cap refused', (await q(`select public.reserve_generation_budget(1000, 2500) ok`)).rows[0].ok === false);
const par = await Promise.all([1, 2, 3, 4].map(() => q(`select public.reserve_generation_budget(200, 2500) ok`)));
check('parallel reserves never exceed cap', par.filter((r) => r.rows[0].ok).length === 2);
await q(`select public.settle_generation_budget((now() at time zone 'utc')::date, 2400, 1800)`);
const b = (await q(`select reserved_cents, spent_cents, blocked from public.generation_budget`)).rows[0];
check('settle moves reserved → spent', b.reserved_cents === 0 && b.spent_cents === 1800 && b.blocked === 3);
// privileges
const priv = (await q(`select
  has_function_privilege('authenticated','public.claim_reel_credit(uuid,uuid,text,text,int)','EXECUTE') a,
  has_function_privilege('anon','public.claim_reel_credit(uuid,uuid,text,text,int)','EXECUTE') b,
  has_function_privilege('authenticated','public.reserve_generation_budget(int,int)','EXECUTE') c,
  has_function_privilege('service_role','public.claim_reel_credit(uuid,uuid,text,text,int)','EXECUTE') d,
  has_table_privilege('authenticated','public.dream_productions','SELECT') e,
  has_table_privilege('authenticated','public.reel_credits','SELECT') f,
  has_table_privilege('authenticated','public.generation_budget','SELECT') g`)).rows[0];
check('browsers cannot call credit/budget functions', !priv.a && !priv.b && !priv.c && priv.d);
check('browsers cannot read productions/credits/budget', !priv.e && !priv.f && !priv.g);
const bucket = (await q(`select public from storage.buckets where id='dream-media'`)).rows[0];
check('dream-media bucket is private', bucket.public === false);
const ev = await q(`insert into public.analytics_events (event) values ('cinematic_failed') returning id`).then(() => true, () => false);
check('new analytics events allowed', ev);
console.log(JSON.stringify(out, null, 1));
process.exit(out.FAIL ? 1 : 0);
