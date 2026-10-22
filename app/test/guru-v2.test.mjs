// Dream Guru V2: intent, entity memory, retrieval, patterns, context and reply guards.
// These test the REAL memory/retrieval logic on hand-made dream memories. They do NOT call
// a language model: whether Orin's actual wording follows the rules needs a live test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyIntent } from '../lib/orin/intent.js';
import { normKey, isSpecific, entityCandidates, findMentions, matchEntity } from '../lib/memory/entities.js';
import { normalizeMemory, sourceHash, followUpsFrom, memoryInput } from '../lib/memory/normalize.js';
import { parseQuery, searchArchive, relevantMemories } from '../lib/memory/search.js';
import { detectPatterns, relateDreams, relationLabel, LINK_THRESHOLD } from '../lib/memory/patterns.js';
import { buildGuruContext, renderContext } from '../lib/orin/context.js';
import { checkReply, questionsLeft, mayOfferVisualize, mentionsPastDreams } from '../lib/orin/guards.js';
import { turnInstructions } from '../lib/orin/persona.js';
import { usageRow } from '../lib/orin/usage.js';
import { accessPlans } from '../lib/access-config.js';

// ---- A tiny in-memory version of what lib/memory/store.js persists ---------------------
let n = 0;
const day = 86400000;
const NOW = Date.UTC(2026, 9, 22, 8);
function dream(memory, daysAgo) {
  n++;
  return { dream_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, dream_at: new Date(NOW - daysAgo * day).toISOString(), ...normalizeMemory(memory) };
}
/** Entities and occurrences as linkEntities() stores them (matchEntity decides same / similar / new). */
function remember(index) {
  const entities = new Map(); const occurrences = {};
  for (const m of index) {
    for (const c of entityCandidates(m)) {
      const hit = matchEntity(c, [...entities.values()]);
      if (!hit) entities.set(`${c.type}:${c.key}`, { id: `e${entities.size + 1}`, entity_type: c.type, norm_key: c.key, label: c.label, specific: c.specific, aliases: [c.mention], occ: [] });
      const e = hit ? hit.entity : entities.get(`${c.type}:${c.key}`);
      const confidence = hit ? hit.confidence : c.confidence;
      e.specific ||= c.specific && !hit;
      e.occ.push({ dream_id: m.dream_id, confidence, emotion: c.emotion, at: m.dream_at });
      (occurrences[m.dream_id] ||= []).push({ entity_id: e.id, confidence, emotion: c.emotion });
    }
  }
  // = the dream_entity_stats view
  const stats = [...entities.values()].map((e) => ({
    ...e, appearances: e.occ.length, dream_ids: e.occ.sort((a, b) => b.at.localeCompare(a.at)).map((o) => o.dream_id),
    emotions: e.occ.map((o) => o.emotion).filter(Boolean), confidence: e.occ.reduce((a, o) => a + o.confidence, 0) / e.occ.length,
    last_seen: e.occ[0].at,
  }));
  return { stats, occurrences };
}
const mem = (o) => ({ title: 'A dream', summary: 'A dream.', cleaned_text: '', dream_type: 'story', emotions: [], themes: [], people: [], places: [], objects: [], creatures: [], events: [], details: [], ...o });

// ---- Intent --------------------------------------------------------------------------------
test('intent: capture, recall, pattern, search, visualize, clarification, reflection', () => {
  assert.equal(classifyIntent('I was walking through a forest and I saw this silver door.'), 'dream_capture');
  assert.equal(classifyIntent('so like, this old house, I think my grandmother’s but not exactly, and my brother was there'), 'dream_capture');
  assert.equal(classifyIntent('Have I dreamed about my brother before?'), 'recall');
  assert.equal(classifyIntent('When did I last dream about water?'), 'recall');
  assert.equal(classifyIntent('Why do I keep dreaming about water?'), 'pattern_question');
  assert.equal(classifyIntent('How many dreams have involved flying?'), 'pattern_question');
  assert.equal(classifyIntent('Show me dreams about flying.'), 'search');
  assert.equal(classifyIntent('What dreams happened in my childhood house?'), 'search');
  assert.equal(classifyIntent('Can you visualize this dream?'), 'visualization_request');
  assert.equal(classifyIntent('Curious, actually. Not scared at all.', { capturing: true, orinAsked: true, hasDream: true }), 'clarification');
  assert.equal(classifyIntent('What do you think the door means?', { hasDream: true }), 'reflection');
  assert.equal(classifyIntent('I also had another dream, about a dog', { hasDream: true }), 'dream_capture');
  assert.equal(classifyIntent('Is my brother in a lot of them?', { mentionsEntity: true }), 'entity_question');
});

// ---- Entity memory ------------------------------------------------------------------------------
test('entities: family words merge, generic places stay cautious', () => {
  assert.equal(normKey('My older Brother!', 'person'), 'brother');
  assert.equal(normKey('mum', 'person'), 'mother');
  assert.equal(normKey('my Mom', 'person'), 'mother');
  assert.equal(normKey('the old train station', 'place'), 'train station');
  assert.equal(normKey('a train station', 'place'), 'train station');
  assert.equal(normKey("Grandmother's house", 'place'), 'grandmother house');
  assert.equal(isSpecific('a woman', 'person'), false);
  assert.equal(isSpecific('my brother', 'person'), true);
  assert.equal(isSpecific("my grandmother's house", 'place'), true);
  assert.equal(isSpecific('a station', 'place'), false);
  const c = entityCandidates(mem({ people: [{ label: 'my brother' }, { label: 'a woman' }], places: [{ label: 'a train station' }] }));
  assert.equal(c.find((x) => x.key === 'brother').confidence, 0.9);
  assert.equal(c.find((x) => x.key === 'brother').label, 'your brother');
  assert.ok(c.find((x) => x.key === 'woman').confidence < 0.5, 'strangers are probably different people');
  assert.equal(c.find((x) => x.key === 'train station').confidence, 0.55);
  assert.ok(!entityCandidates(mem({ people: [{ label: 'me' }, { label: 'the dreamer' }] })).length, 'the dreamer is not an entity');
  const known = [{ id: 'b', entity_type: 'person', norm_key: 'brother', aliases: ['my brother'] }, { id: 's', entity_type: 'place', norm_key: 'train station', aliases: [] }];
  assert.deepEqual(findMentions("I dreamed about my bro's car", known).map((e) => e.id), ['b']);
  assert.deepEqual(findMentions('I saw the train stations again', known).map((e) => e.id), ['s']);
  assert.deepEqual(findMentions('a brothel', known), [], 'whole words only');
});

// ---- Level 1 memory -------------------------------------------------------------------------------
test('memory: model output is validated; original words are never part of it', () => {
  const m = normalizeMemory({ title: 'The Silver Door.', summary: 'You walked through a forest and found a silver door.', cleaned_text: 'I was walking…', dream_type: 'weird', emotions: ['Curious', 'curious', 'calm'], people: 'nope', places: [{ label: 'a forest', familiar: 'yes' }, { nolabel: true }], themes: ['doors'] });
  assert.equal(m.title, 'The Silver Door');
  assert.equal(m.dream_type, 'story');
  assert.deepEqual(m.emotions, ['curious', 'calm']);
  assert.deepEqual(m.people, []);
  assert.deepEqual(m.places, [{ label: 'a forest', description: null, familiar: false }]);
  assert.ok(!('transcript' in m));
  assert.throws(() => normalizeMemory({ title: 'x' }));
  assert.notEqual(sourceHash('a'), sourceHash('b'), 'an edit means a rebuild');
  assert.notEqual(sourceHash('a', []), sourceHash('a', [{ question: 'q', answer: 'yes' }]), 'a follow-up answer means a rebuild');
  const pairs = followUpsFrom([
    { role: 'user', content: 'I was in a house.' },
    { role: 'assistant', content: 'That sounds vivid. Did the house feel familiar?' },
    { role: 'user', content: 'Yes, like my gran’s.' },
  ]);
  assert.deepEqual(pairs, [{ question: 'Did the house feel familiar?', answer: 'Yes, like my gran’s.' }]);
  assert.match(memoryInput({ transcript: 'raw words', followUps: pairs }), /raw words[\s\S]*Follow-up answers/);
});

// ---- TEST A: first dream -------------------------------------------------------------------------
test('A — first dream: no history in the context, invented past is caught', () => {
  const current = { id: 'x', transcript: 'I was walking through a forest and I saw this silver door.', created_at: new Date(NOW).toISOString() };
  const ctx = buildGuruContext({ currentDream: current, relevant: [], activity: { total: 1, week: 1, month: 1 } });
  assert.equal(ctx.firstDream, true);
  const text = renderContext(ctx);
  assert.match(text, /no earlier dreams are saved/);
  assert.doesNotMatch(text, /\[D1\]/);
  assert.match(turnInstructions('dream_capture', { questionsLeft: 2, firstDream: true }), /first dream/);
  const bad = checkReply(JSON.stringify({ text: 'You’ve dreamed about doors before — this one again.', cited_dream_ids: ['D1'] }), { refs: ctx.refs, firstDream: true });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.cited, [], 'cannot cite a dream it was never given');
  const good = checkReply(JSON.stringify({ text: 'A silver door in a forest. I’ve kept this one. How did you feel when you saw it?', asked_question: true, expression: 'curious' }), { refs: ctx.refs, firstDream: true });
  assert.equal(good.ok, true);
  assert.equal(good.askedQuestion, true);
  assert.equal(checkReply(JSON.stringify({ text: 'You said you had it again.' }), { firstDream: true, userSaidAgain: true }).ok, true, 'echoing their own "again" is fine');
});

// ---- TEST B: recurring person ------------------------------------------------------------------------
test('B — recurring person: "Have I dreamed about my brother before?" finds both dreams', () => {
  const d1 = dream(mem({ title: 'The Station', summary: 'You were at a station with your brother.', people: [{ label: 'my brother' }], places: [{ label: 'a station' }] }), 10);
  const d2 = dream(mem({ title: 'Beach Again', summary: 'Your brother was there again, at the beach.', people: [{ label: 'my brother' }], places: [{ label: 'the beach' }] }), 3);
  const other = dream(mem({ title: 'Glass Tower', summary: 'A glass tower above the sea.', places: [{ label: 'a tower' }], themes: ['water'] }), 1);
  const index = [other, d2, d1];
  const { stats, occurrences } = remember(index);
  const q = parseQuery('Have I dreamed about my brother before?', stats);
  const r = searchArchive(index, q, { occurrences });
  assert.equal(r.count, 2);
  assert.deepEqual(r.matches.map((x) => x.memory.dream_id), [d2.dream_id, d1.dream_id]);
  assert.equal(stats.find((e) => e.norm_key === 'brother').appearances, 2);
  const ctx = buildGuruContext({ archive: r, activity: { total: 3, week: 2, month: 3 } });
  assert.match(renderContext(ctx), /2 matching dreams/);
});

// ---- TEST C: recurring place ---------------------------------------------------------------------------
test('C — recurring place: similar stations are linked, but never asserted to be the same', () => {
  const s1 = dream(mem({ title: 'Leaving', summary: 'You were trying to leave a station.', places: [{ label: 'a train station' }], emotions: ['anxious'] }), 20);
  const s2 = dream(mem({ title: 'Missed Train', summary: 'You missed a train at the station.', places: [{ label: 'the station' }], emotions: ['anxious'] }), 9);
  const unrelated = dream(mem({ title: 'Garden', summary: 'A quiet garden.', places: [{ label: 'a garden' }] }), 2);
  const index = [unrelated, s2, s1];
  const { stats, occurrences } = remember(index);
  const now = 'I saw the train station again, but this time I was waiting for someone.';
  const top = relevantMemories(index, parseQuery(now, stats), { occurrences });
  assert.ok(top.length >= 1 && top.every((r) => r.memory.dream_id !== unrelated.dream_id), 'only station dreams');
  assert.ok(top.some((r) => r.why.some((w) => w.kind === 'place' && w.sameness === 'similar')));
  const text = renderContext(buildGuruContext({ relevant: top, activity: { total: 3, week: 1, month: 3 } }));
  assert.match(text, /similar, maybe not the same/);
  const ents = new Map(stats.map((e) => [e.id, e]));
  const link = relateDreams(s1, s2, occurrences[s1.dream_id], occurrences[s2.dream_id], ents);
  assert.ok(link.score >= LINK_THRESHOLD);
  assert.match(relationLabel(link), /Another dream involving a (train )?station/);
});

// ---- TEST D: pattern ----------------------------------------------------------------------------------------
test('D — water pattern: what was observed, counted from real dreams', () => {
  const ds = [
    dream(mem({ summary: 'Water rose in the kitchen.', themes: ['water'], emotions: ['afraid'] }), 30),
    dream(mem({ summary: 'You swam in a warm sea.', emotions: ['calm'] }), 12),
    dream(mem({ summary: 'A flood at school.', emotions: ['afraid'] }), 5),
    dream(mem({ summary: 'You were late for a bus.', themes: ['being late'] }), 3),
    dream(mem({ summary: 'A party with friends.' }), 1),
  ];
  const { stats } = remember(ds);
  const patterns = detectPatterns(ds, stats, NOW);
  const water = patterns.find((p) => p.pattern_key === 'theme:water');
  assert.equal(water.strength, 3);
  assert.match(water.description, /^Water appeared in 3 of 5 dreams/);
  assert.ok(!patterns.some((p) => /subconscious|means|because|trauma|anxiety disorder/i.test(p.description)), 'no interpretation, no diagnosis');
  const r = searchArchive(ds, parseQuery('Why do I keep dreaming about water?', stats), {});
  assert.equal(r.count, 3);
  assert.match(turnInstructions('pattern_question', { archive: r }), /actually observed[\s\S]*never universal symbolism/);
});

// ---- TEST E: search -----------------------------------------------------------------------------------------
test('E — "Show me dreams about flying" returns exactly the flying dreams', () => {
  const f1 = dream(mem({ summary: 'You were flying over the city.', themes: ['flying'] }), 8);
  const f2 = dream(mem({ summary: 'You flew above the trees, then woke.' }), 2);
  const stairs = dream(mem({ summary: 'You climbed a long flight of stairs.' }), 4);
  const water = dream(mem({ summary: 'A lake at night.', themes: ['water'] }), 1);
  const r = searchArchive([water, f2, stairs, f1], parseQuery('Show me dreams about flying.', []), {});
  assert.deepEqual(r.matches.map((x) => x.memory.dream_id), [f2.dream_id, f1.dream_id]);
  const none = searchArchive([water], parseQuery('Show me dreams about teeth', []), {});
  assert.equal(none.count, 0);
  assert.match(renderContext(buildGuruContext({ archive: none, activity: { total: 1, week: 1, month: 1 } })), /no matching dreams/);
  assert.match(turnInstructions('search', { archive: none }), /NO matching dreams/);
});

// ---- TEST F: deletion --------------------------------------------------------------------------------------------
test('F — deleting a water dream: counts, patterns and citations update', () => {
  const ds = [1, 2, 3].map((i) => dream(mem({ summary: `Water dream ${i}.`, themes: ['water'], people: [{ label: 'my mum' }] }), i * 3));
  let { stats } = remember(ds);
  assert.equal(detectPatterns(ds, stats, NOW).find((p) => p.pattern_key === 'theme:water').strength, 3);
  const gone = ds[0].dream_id;
  const left = ds.slice(1);           // the database cascade removes its memory and occurrences
  ({ stats } = remember(left));
  const after = detectPatterns(left, stats, NOW);
  assert.equal(after.find((p) => p.pattern_key === 'theme:water').strength, 2);
  assert.ok(after.every((p) => !p.dream_ids.includes(gone)), 'no pattern stands on the deleted dream');
  // Even a stale pattern row (e.g. if the rebuild failed) is filtered against live dreams:
  const stalePattern = { dream_ids: [gone, ds[1].dream_id] };
  assert.equal(stalePattern.dream_ids.filter((id) => new Set(left.map((m) => m.dream_id)).has(id)).length, 1);
  const ctx = buildGuruContext({ relevant: relevantMemories(left, parseQuery('water', stats)), activity: { total: 2, week: 1, month: 2 } });
  assert.ok(![...ctx.refs.values()].includes(gone));
  assert.deepEqual(checkReply(JSON.stringify({ text: 'ok', cited_dream_ids: ['D9'] }), { refs: ctx.refs }).cited, []);
});

// ---- TEST G / H: structure only (behaviour needs the live app) ---------------------------------------------
test('G — voice and text use ONE conversation endpoint with the same conversation id', () => {
  const src = readFileSync(new URL('../components/GuruScreen.js', import.meta.url), 'utf8');
  assert.equal((src.match(/\/api\/guru\/talk/g) || []).length, 1, 'one call site for both voice and text');
  assert.match(src, /form\.append\('conversationId', conversationId\)/);
});

test('H — visualize reuses the saved dream and the existing Dream Director start', () => {
  const src = readFileSync(new URL('../app/api/dreams/[id]/visualize/route.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from\('dreams'\)\.insert/, 'never creates a second dream');
  assert.match(src, /startCinematic\(\{ userId: user\.id, dreamId: id, ent \}\)/);
  const director = readFileSync(new URL('../app/api/dreams/route.js', import.meta.url), 'utf8');
  assert.match(director, /startCinematic\(/, 'recording a reel uses the same start');
});

// ---- Guards, allowance, cost ----------------------------------------------------------------------------------
test('follow-up questions: at most two while capturing', () => {
  assert.equal(questionsLeft({ clarifications: 0 }), 2);
  assert.equal(questionsLeft({ clarifications: 2 }), 0);
  assert.match(turnInstructions('clarification', { questionsLeft: 0 }), /Do not ask any more questions/);
  assert.match(turnInstructions('dream_capture', { questionsLeft: 1 }), /ONE short follow-up question/);
});

test('visualize is offered rarely, only for vivid saved dreams without a reel', () => {
  const vivid = { transcript: 'word '.repeat(60), scenes: [] };
  const memory = { places: [{ label: 'a forest' }], objects: [{ label: 'a silver door' }], dream_type: 'story' };
  const base = { dream: vivid, memory, hasProduction: false, canGenerateReel: true, offeredAlready: false, userTurns: 2 };
  assert.equal(mayOfferVisualize(base), true);
  assert.equal(mayOfferVisualize({ ...base, offeredAlready: true }), false);
  assert.equal(mayOfferVisualize({ ...base, canGenerateReel: false }), false);
  assert.equal(mayOfferVisualize({ ...base, hasProduction: true }), false);
  assert.equal(mayOfferVisualize({ ...base, userTurns: 1 }), false);
  assert.equal(mayOfferVisualize({ ...base, dream: { transcript: 'a door', scenes: [] } }), false);
  assert.equal(mayOfferVisualize({ ...base, memory: { ...memory, dream_type: 'fragment' } }), false);
});

test('past-dream claims are recognised', () => {
  assert.ok(mentionsPastDreams('In one of your earlier dreams the water rose too.'));
  assert.ok(mentionsPastDreams('You’ve mentioned a station before.'));
  assert.ok(!mentionsPastDreams('A silver door in a forest — that is striking.'));
});

test('context stays compact: at most 4 related dreams, capped dream text', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ memory: dream(mem({ summary: `Dream ${i}` }), i), score: 1, why: [] }));
  const ctx = buildGuruContext({ currentDream: { id: 'c', transcript: 'x'.repeat(9000), created_at: new Date(NOW).toISOString() }, relevant: many, activity: { total: 11, week: 3, month: 11 } });
  assert.equal(ctx.memories.length, 4);
  assert.ok(renderContext(ctx).length < 5000);
});

test('plans: Guru allowances are configurable, free is limited', () => {
  const p = accessPlans({ FREE_GURU_TEXT_PER_DAY: '5', PREMIUM_GURU_VOICE_PER_DAY: '99' });
  assert.equal(p.free.guruTextPerDay, 5);
  assert.equal(p.premium.guruVoicePerDay, 99);
  assert.ok(p.free.recallDepth < p.premium.recallDepth);
  assert.equal(p.free.canViewAdvancedPatterns, false);
});

test('cost rows hold numbers only', () => {
  const r = usageRow({ kind: 'llm', model: 'gpt-4.1', usage: { prompt_tokens: 1000, completion_tokens: 200 } });
  assert.deepEqual(Object.keys(r).sort(), ['est_usd', 'kind', 'model', 'quantity', 'unit']);
  assert.equal(r.est_usd, 0.0036);
  assert.ok(usageRow({ kind: 'tts', model: 'x', seconds: 30 }).est_usd > 0);
});
