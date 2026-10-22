// npm run test:sql — runs ALL real migrations in order on a local Postgres (PGlite) with stub
// Supabase schemas, then checks Dream Guru V2 privacy (row level security as two different
// signed-in people), deletion cascades, live entity counts and re-runnability.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();
const q = (s, p) => db.query(s, p);
await db.exec(readFileSync(new URL('./supabase-stub.sql', import.meta.url), 'utf8'));
const files = ['20261012_guru_and_premium.sql', '20261015_reels_v1.sql', '20261015_privacy_lockdown.sql', '20261017_dream_director.sql', '20261022_guru_memory.sql'];
for (const f of files) await db.exec(readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8'));
await db.exec(readFileSync(new URL('../supabase/migrations/20261022_guru_memory.sql', import.meta.url), 'utf8')); // re-runnable

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
await q(`insert into auth.users values ($1), ($2)`, [A, B]);
const out = {}; const check = (k, v) => { out[k] = Boolean(v); if (!v) out.FAIL = true; };

/** Runs a statement AS a signed-in person (role authenticated + their id), like the app does. */
async function as(user, sql, params) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${user}', false);`);
  try { return await db.query(sql, params); } finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`); }
}
const fails = (p) => p.then(() => false, () => true);

// --- A saves a Guru dream and its memory -------------------------------------------------
const d1 = (await as(A, `insert into dreams (user_id, transcript, status, source, is_public) values ($1, 'I was at a station with my brother', 'saved', 'guru', false) returning id`, [A])).rows[0].id;
const d2 = (await as(A, `insert into dreams (user_id, transcript, status, source, is_public) values ($1, 'My brother was there again, at the beach', 'saved', 'guru', false) returning id`, [A])).rows[0].id;
const c1 = (await as(A, `insert into guru_conversations (user_id, dream_id) values ($1, $2) returning id`, [A, d1])).rows[0].id;
await as(A, `insert into guru_messages (conversation_id, dream_id, user_id, role, content) values ($1, $2, $3, 'user', 'I was at a station')`, [c1, d1, A]);
await as(A, `insert into guru_messages (conversation_id, dream_id, user_id, role, content) values ($1, null, $2, 'assistant', 'A message with no dream')`, [c1, A]);
for (const [d, s] of [[d1, 'At a station with your brother.'], [d2, 'Your brother at the beach.']]) {
  await as(A, `insert into dream_memories (dream_id, user_id, status, summary, cleaned_text, themes) values ($1, $2, 'ready', $3, $3, '{water}')`, [d, A, s]);
}
const brother = (await as(A, `insert into dream_entities (user_id, entity_type, norm_key, label, specific) values ($1, 'person', 'brother', 'your brother', true) returning id`, [A])).rows[0].id;
const station = (await as(A, `insert into dream_entities (user_id, entity_type, norm_key, label) values ($1, 'place', 'station', 'station') returning id`, [A])).rows[0].id;
await as(A, `insert into dream_entity_occurrences (entity_id, dream_id, user_id, confidence, emotion) values ($1, $2, $4, 0.9, 'calm'), ($1, $3, $4, 0.9, 'calm'), ($5, $2, $4, 0.55, null)`, [brother, d1, d2, A, station]);
const [lo, hi] = [d1, d2].sort();
await as(A, `insert into dream_links (user_id, dream_a, dream_b, score, reasons) values ($1, $2, $3, 2.3, '[]')`, [A, lo, hi]);
await as(A, `insert into dream_patterns (user_id, pattern_key, pattern_type, description, dream_ids, strength) values ($1, 'entity:person:brother', 'recurring_entity', 'Your brother appeared in 2 of 2 dreams.', $2, 2)`, [A, [d1, d2]]);
check('guru message without a dream is allowed (conversation-level)', true);

const stats = (await as(A, `select norm_key, appearances from dream_entity_stats where user_id = $1 order by norm_key`, [A])).rows;
check('live entity counts: brother 2, station 1', stats.find((s) => s.norm_key === 'brother')?.appearances === 2 && stats.find((s) => s.norm_key === 'station')?.appearances === 1);
check('full-text search finds the dream', (await as(A, `select dream_id from dream_memories where search @@ websearch_to_tsquery('english', 'stations')`)).rows.length === 1);

// --- B can see none of it, and can't write into A's dreams -------------------------------
for (const t of ['dreams', 'dream_memories', 'dream_entities', 'dream_entity_occurrences', 'dream_links', 'dream_patterns', 'guru_conversations', 'guru_messages', 'dream_entity_stats']) {
  check(`B cannot read A's ${t}`, (await as(B, `select * from ${t}`)).rows.length === 0);
}
check('B cannot attach a memory to A\'s dream', await fails(as(B, `insert into dream_memories (dream_id, user_id, status) values ($1, $2, 'ready')`, [d1, B])));
check('B cannot add an occurrence to A\'s dream', await fails(as(B, `insert into dream_entity_occurrences (entity_id, dream_id, user_id) values ($1, $2, $3)`, [brother, d1, B])));
check('B cannot start a conversation on A\'s dream', await fails(as(B, `insert into guru_conversations (user_id, dream_id) values ($1, $2)`, [B, d1])));
check('B cannot post into A\'s conversation', await fails(as(B, `insert into guru_messages (conversation_id, user_id, role, content) values ($1, $2, 'user', 'hi')`, [c1, B])));
check('B cannot pretend to be A', await fails(as(B, `insert into dream_patterns (user_id, pattern_key, pattern_type, description) values ($1, 'x', 'x', 'x')`, [A])));
check('B cannot delete A\'s dream', (await as(B, `delete from dreams where id = $1 returning id`, [d1])).rows.length === 0);
check('B cannot update A\'s memory', (await as(B, `update dream_memories set summary = 'x' where dream_id = $1 returning dream_id`, [d1])).rows.length === 0);
check('guru messages cannot be deleted from the browser', (await as(A, `delete from guru_messages returning id`)).rows.length === 0);
check('usage: people can add cost rows but not read them', !(await fails(as(A, `insert into guru_usage (user_id, kind, model, quantity, unit, est_usd) values ($1, 'llm', 'gpt-4.1', 100, 'tokens', 0.001)`, [A])))
  && (await as(A, `select * from guru_usage`)).rows.length === 0);
check('new dreams from this migration era stay private by default', (await q(`select column_default from information_schema.columns where table_name = 'dreams' and column_name = 'is_public'`)).rows[0].column_default === 'false');

// --- Deleting a dream removes everything derived from it ---------------------------------
await as(A, `delete from dreams where id = $1`, [d1]);
check('memory deleted with the dream', (await q(`select 1 from dream_memories where dream_id = $1`, [d1])).rows.length === 0);
check('entity occurrences deleted with the dream', (await q(`select 1 from dream_entity_occurrences where dream_id = $1`, [d1])).rows.length === 0);
check('related-dream links deleted with the dream', (await q(`select 1 from dream_links`)).rows.length === 0);
check('the dream\'s Guru messages deleted with it', (await q(`select 1 from guru_messages where dream_id = $1`, [d1])).rows.length === 0);
check('conversation survives, detached from the deleted dream', (await q(`select dream_id from guru_conversations where id = $1`, [c1])).rows[0]?.dream_id === null);
const after = (await as(A, `select norm_key, appearances, dream_ids from dream_entity_stats where user_id = $1`, [A])).rows;
check('brother count drops to 1 and only lists the surviving dream', after.find((s) => s.norm_key === 'brother')?.appearances === 1 && after.find((s) => s.norm_key === 'brother').dream_ids.join() === d2);
check('station now has 0 appearances (pruned by the app)', after.find((s) => s.norm_key === 'station')?.appearances === 0);

// --- Analytics: new events allowed, text-like events refused ------------------------------
check('new Guru events accepted', !(await fails(as(A, `insert into analytics_events (user_id, event, props) values ($1, 'dream_saved', '{"source":"guru"}')`, [A]))));
check('unknown events refused', await fails(as(A, `insert into analytics_events (user_id, event) values ($1, 'my dream about my ex')`, [A])));

console.log(JSON.stringify(out, null, 1));
process.exit(out.FAIL ? 1 : 0);
