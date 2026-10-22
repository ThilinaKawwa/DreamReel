// npm run test:integration — the REAL memory code (lib/memory/store.js) against a REAL Postgres
// through PostgREST (the same REST layer Supabase uses), signed in as two different people,
// with every migration applied and row level security on.
//
// Needs a local Postgres and a PostgREST binary:
//   PG_HOST=/var/tmp/dreamreel-pg PG_PORT=54329 PGRST_BIN=/path/to/postgrest npm run test:integration
// Without them it prints SKIPPED. The language model is replaced by a fixed extractor
// (FAKE_MODEL below): this verifies storage, matching, retrieval, patterns, deletion and
// privacy — NOT the quality of real model output.
import { startDatabase } from './harness/pg.mjs';
import { buildMemory, loadIndex, loadEntityStats, loadOccurrences, loadPatterns, forgetDream, markStale, dreamsNeedingMemory, recomputePatterns } from '../lib/memory/store.js';
import { parseQuery, searchArchive, relevantMemories } from '../lib/memory/search.js';
import { buildGuruContext, renderContext } from '../lib/orin/context.js';

const PG_HOST = process.env.PG_HOST, PG_PORT = process.env.PG_PORT || '5432', BIN = process.env.PGRST_BIN;
if (!PG_HOST || !BIN) { console.log('SKIPPED (set PG_HOST and PGRST_BIN)'); process.exit(0); }

const { psql, as, A, B, stop } = await startDatabase({ PG_HOST, PG_PORT, BIN });
const dbA = as(A), dbB = as(B);

// The stand-in for the extraction model: fixed memories keyed by words in the transcript.
const FAKE_MODEL = [
  [/station with my brother/, { title: 'The Station', summary: 'You were at a station with your brother, trying to leave.', cleaned_text: 'I was at a train station with my brother. I was trying to leave.', emotions: ['anxious'], people: [{ label: 'my brother' }], places: [{ label: 'a train station' }], themes: [] }],
  [/beach/, { title: 'Brother at the Beach', summary: 'Your brother was there again, at the beach.', cleaned_text: 'My brother was there again, this time at the beach. The sea was calm.', emotions: ['calm'], people: [{ label: 'my brother' }], places: [{ label: 'the beach' }], themes: ['water'] }],
  [/station again/, { title: 'Waiting', summary: 'You were waiting for someone at the station.', cleaned_text: 'I saw the station again but this time I was waiting for someone.', emotions: ['curious'], places: [{ label: 'the station' }], themes: [] }],
  [/flood/, { title: 'The Flood', summary: 'Water flooded the kitchen.', cleaned_text: 'The kitchen flooded with water.', emotions: ['afraid'], places: [{ label: 'my kitchen' }], themes: ['water'] }],
  [/flying/, { title: 'Above the City', summary: 'You were flying above the city.', cleaned_text: 'I was flying above the city at night.', emotions: ['free'], places: [{ label: 'a city' }], themes: ['flying'] }],
  [/silver door/, { title: 'The Silver Door', summary: 'You found a silver door in a forest.', cleaned_text: 'I was walking through a forest and I saw a silver door.', emotions: ['curious'], places: [{ label: 'a forest' }], objects: [{ label: 'a silver door' }], themes: [] }],
];
let modelCalls = 0, failNext = false;
const openai = { chat: { completions: { create: async ({ messages }) => {
  modelCalls++;
  if (failNext) { failNext = false; throw new Error('model unavailable'); }
  const said = messages[1].content;
  const hit = FAKE_MODEL.find(([re]) => re.test(said));
  return { choices: [{ message: { content: JSON.stringify({ dream_type: 'story', events: [], details: [], objects: [], creatures: [], people: [], ...(hit ? hit[1] : { title: 'Dream', summary: 'A dream.' }) }) } }], usage: { prompt_tokens: 500, completion_tokens: 150 } };
} } } };

const out = {}; const check = (k, v) => { out[k] = Boolean(v); if (!v) out.FAIL = true; };
const save = async (db, user, transcript, daysAgo = 0) => {
  const { data, error } = await db.from('dreams').insert({ user_id: user, transcript, status: 'saved', source: 'guru', is_public: false }).select('id').single();
  if (error) throw error;
  if (daysAgo) psql(`update dreams set created_at = now() - interval '${daysAgo} days' where id = '${data.id}'`);
  return data.id;
};
const state = async (db, user) => {
  const [index, stats, occurrences] = await Promise.all([loadIndex(db, user), loadEntityStats(db, user), loadOccurrences(db, user)]);
  return { index, stats, occurrences };
};

try {
  // A — first dream: saved, memory built, no history.
  const door = await save(dbA, A, 'I was walking through a forest and I saw this silver door.', 9);
  check('A: memory built for the first dream', (await buildMemory(dbA, openai, { userId: A, dreamId: door })) === 'built');
  const { data: titled } = await dbA.from('dreams').select('title, transcript').eq('id', door).single();
  check('A: untitled dream gets its title; original words untouched', titled.title === 'The Silver Door' && titled.transcript === 'I was walking through a forest and I saw this silver door.');
  let s = await state(dbA, A);
  const ctxA = buildGuruContext({ currentDream: { id: door, transcript: 'x', created_at: new Date().toISOString() }, relevant: relevantMemories(s.index, parseQuery('silver door forest', s.stats), { occurrences: s.occurrences, exclude: door }), activity: { total: 1, week: 0, month: 1 } });
  check('A: first-dream context has no past dreams', ctxA.firstDream && !ctxA.memories.length && /no earlier dreams/.test(renderContext(ctxA)));
  check('A: rebuilding an unchanged dream is skipped (no extra AI cost)', (await buildMemory(dbA, openai, { userId: A, dreamId: door })) === 'fresh');

  // B — recurring person
  const st1 = await save(dbA, A, 'I was at a station with my brother', 8);
  const beach = await save(dbA, A, 'My brother was there again, this time at the beach', 6);
  for (const id of [st1, beach]) await buildMemory(dbA, openai, { userId: A, dreamId: id });
  s = await state(dbA, A);
  const bro = searchArchive(s.index, parseQuery('Have I dreamed about my brother before?', s.stats), { occurrences: s.occurrences });
  check('B: brother found in exactly 2 dreams', bro.count === 2 && bro.matches.every((r) => [st1, beach].includes(r.memory.dream_id)));
  check('B: live entity count for brother is 2', s.stats.find((e) => e.norm_key === 'brother')?.appearances === 2);
  const { data: link } = await dbA.from('dream_links').select('dream_a, dream_b, reasons').eq('user_id', A);
  check('B: the two brother dreams are linked as related', (link || []).some((l) => [l.dream_a, l.dream_b].sort().join() === [st1, beach].sort().join()));

  // C — recurring place: "the station" joins "a train station" only as SIMILAR
  const st2 = await save(dbA, A, 'I saw the station again, this time I was waiting for someone', 2);
  await buildMemory(dbA, openai, { userId: A, dreamId: st2 });
  s = await state(dbA, A);
  const near = relevantMemories(s.index, parseQuery('I saw the station again, this time I was waiting for someone', s.stats), { occurrences: s.occurrences, exclude: st2 });
  check('C: the earlier station dream is retrieved', near.some((r) => r.memory.dream_id === st1));
  check('C: …marked similar, not asserted the same', near.find((r) => r.memory.dream_id === st1)?.why.some((w) => w.kind === 'place' && w.sameness === 'similar'));
  const { data: stOcc } = await dbA.from('dream_entity_occurrences').select('confidence').eq('dream_id', st2);
  check('C: low confidence stored for the guessed match', stOcc.length === 1 && stOcc[0].confidence <= 0.5);

  // D — patterns from stored data
  const flood = await save(dbA, A, 'The kitchen had a flood', 1);
  await buildMemory(dbA, openai, { userId: A, dreamId: flood });
  const water = (await loadPatterns(dbA, A)).find((p) => p.pattern_key === 'theme:water');
  check('D: water pattern = 2 dreams, worded as an observation', water?.strength === 2 && /^Water appeared in 2 of \d+ dreams/.test(water.description));
  check('D: brother recurring pattern stored', (await loadPatterns(dbA, A)).some((p) => p.pattern_key === 'entity:person:brother' && p.strength === 2));

  // E — search returns only real matches
  const fly = await save(dbA, A, 'I was flying above the city', 0);
  await buildMemory(dbA, openai, { userId: A, dreamId: fly });
  s = await state(dbA, A);
  const flying = searchArchive(s.index, parseQuery('Show me dreams about flying.', s.stats), { occurrences: s.occurrences });
  check('E: flying search returns exactly the flying dream', flying.count === 1 && flying.matches[0].memory.dream_id === fly);
  check('E: no matches → zero (nothing invented)', searchArchive(s.index, parseQuery('Show me dreams about teeth', s.stats), {}).count === 0);

  // Privacy — B sees nothing of A, even through the real REST layer
  const sB = await state(dbB, B);
  check('privacy: B has no index, entities or occurrences of A', !sB.index.length && !sB.stats.length && !Object.keys(sB.occurrences).length);
  check('privacy: B cannot build a memory for A\'s dream', (await buildMemory(dbB, openai, { userId: B, dreamId: door })) === 'skipped');
  check('privacy: B cannot read A\'s patterns or links', !(await loadPatterns(dbB, B)).length && !((await dbB.from('dream_links').select('*')).data || []).length);
  const bTry = await dbB.from('dream_memories').update({ summary: 'hacked' }).eq('dream_id', door).select();
  check('privacy: B cannot edit A\'s memory', !(bTry.data || []).length);
  const { data: still } = await dbA.from('dream_memories').select('summary').eq('dream_id', door).single();
  check('privacy: A\'s memory unchanged', still.summary === 'You found a silver door in a forest.');

  // Edit — the memory follows the new words
  await dbA.from('dreams').update({ transcript: 'I was flying above the city, then I fell into a flood' }).eq('id', fly);
  await markStale(dbA, A, fly);
  psql(`update dream_memories set updated_at = now() - interval '5 minutes' where dream_id = '${fly}'`);
  check('edit: stale memory is picked up for rebuilding', (await dreamsNeedingMemory(dbA, A, 5)).includes(fly));
  const before = modelCalls;
  check('edit: memory rebuilt from the new words', (await buildMemory(dbA, openai, { userId: A, dreamId: fly })) === 'built' && modelCalls === before + 1);

  // Failure — the dream survives; derived data marked failed for a retry
  const fragile = await save(dbA, A, 'Something about a silver door again', 0);
  failNext = true;
  let threw = false;
  try { await buildMemory(dbA, openai, { userId: A, dreamId: fragile }); } catch { threw = true; }
  const { data: fm } = await dbA.from('dream_memories').select('status').eq('dream_id', fragile).single();
  const { data: fd } = await dbA.from('dreams').select('id').eq('id', fragile).maybeSingle();
  check('failure: extraction error keeps the dream saved and marks memory failed', threw && fm.status === 'failed' && fd?.id === fragile);
  check('failure: still searchable from its own words before memory exists', searchArchive((await state(dbA, A)).index, parseQuery('silver door', []), {}).matches.some((r) => r.memory.dream_id === fragile));

  // F — deletion: counts, patterns, links and citations all forget it
  await dbA.from('dreams').delete().eq('id', beach);
  await forgetDream(dbA, A);
  s = await state(dbA, A);
  check('F: brother now in 1 dream', s.stats.find((e) => e.norm_key === 'brother')?.appearances === 1);
  check('F: beach entity removed entirely', !s.stats.some((e) => e.norm_key === 'beach') && !((await dbA.from('dream_entities').select('id').eq('norm_key', 'beach')).data || []).length);
  const pats = await loadPatterns(dbA, A);
  check('F: no pattern refers to the deleted dream', pats.every((p) => !p.dream_ids.includes(beach)));
  check('F: brother no longer a recurring pattern', !pats.some((p) => p.pattern_key === 'entity:person:brother'));
  check('F: no links to the deleted dream', !((await dbA.from('dream_links').select('*').or(`dream_a.eq.${beach},dream_b.eq.${beach}`)).data || []).length);
  check('F: search no longer returns it', !searchArchive(s.index, parseQuery('beach brother', s.stats), { occurrences: s.occurrences }).matches.some((r) => r.memory.dream_id === beach));
  check('patterns: recompute is idempotent', (await recomputePatterns(dbA, A)) === (await recomputePatterns(dbA, A)));
} catch (e) {
  console.error(e);
  out.FAIL = true;
}
console.log(JSON.stringify(out, null, 1));
stop();
process.exit(out.FAIL ? 1 : 0);
