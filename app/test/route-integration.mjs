// npm run test:integration (second half) — drives the REAL Next.js API routes (next dev) against a REAL Postgres
// through PostgREST, signed in as two different people. Only two things are stand-ins:
//   * Supabase Auth's "who is this token?" endpoint (answers from our test JWTs), and
//   * OpenAI (FAKE replies below). So this verifies the plumbing — saving, conversation state,
//     retrieval, privacy, allowance, deletion — NOT the quality of Orin's real answers.
// Needs: PG_HOST, PG_PORT, PGRST_BIN (see test/memory-integration.mjs). Prints SKIPPED otherwise.
import { startStack, A, B } from './harness/app.mjs';

const { PG_HOST, PG_PORT = '5432', PGRST_BIN: BIN } = process.env;
if (!PG_HOST || !BIN) { console.log('SKIPPED (set PG_HOST and PGRST_BIN)'); process.exit(0); }
const { talk, call, q1, psql, waitFor, prompts, state, stop, log } = await startStack({ PG_HOST, PG_PORT, BIN, env: { FREE_GURU_TEXT_PER_DAY: '30' } });

const out = {}; const check = (k, v) => { out[k] = Boolean(v); if (!v) out.FAIL = true; };
try {
  // TEST A — first dream, typed. Saved before Orin answers; no invented past.
  const a1 = await talk(A, { text: 'I was walking through a forest and I saw this silver door.' });
  check('A: 200 + dream saved + new dream', a1.status === 200 && a1.saved && a1.newDream && a1.dreamId);
  check('A: saved as a private Guru dream', q1(`select source || ',' || status || ',' || is_public from dreams where id = '${a1.dreamId}'`) === 'guru,saved,false');
  check('A: first-dream prompt says there is no history', /no earlier dreams are saved/.test(prompts.at(-1).sys));
  check('A: Orin asks one follow-up', /\?$/.test(a1.answer) && a1.intent === 'dream_capture');

  // Clarification in the same conversation → appended to the same dream; memory built after.
  const a2 = await talk(A, { text: 'Curious, actually. Not scared.', conversationId: a1.conversationId });
  check('A: answer treated as clarification, same dream', a2.intent === 'clarification' && a2.dreamId === a1.dreamId && a2.saved && !a2.newDream);
  check('A: the answer is part of the dream’s own words', /Curious, actually/.test(q1(`select transcript from dreams where id = '${a1.dreamId}'`)));
  check('A: memory built in the background', await waitFor(() => q1(`select coalesce((select status from dream_memories where dream_id = '${a1.dreamId}'), 'none')`) === 'ready'));
  check('A: follow-up recorded for memory', /Curious/.test(q1(`select follow_ups::text from dream_memories where dream_id = '${a1.dreamId}'`)));
  check('A: exactly one dream for the whole capture', q1(`select count(*) from dreams where user_id = '${A}'`) === '1');

  // TEST G — voice joins the same conversation and memory; reply comes back spoken.
  state.transcription = 'It was very quiet in the forest.';
  const audio = new Blob([Buffer.alloc(4000, 1)], { type: 'audio/webm' });
  const g = await talk(A, { audio, conversationId: a1.conversationId });
  check('G: voice turn continues the same conversation', g.status === 200 && g.conversationId === a1.conversationId);
  check('G: spoken reply returned', typeof g.audio === 'string' && g.audio.length > 100);
  check('G: voice message stored as voice in the same conversation', q1(`select count(*) from guru_messages where conversation_id = '${a1.conversationId}' and via_voice and role = 'user'`) === '1'
    && Number(q1(`select count(*) from guru_messages where conversation_id = '${a1.conversationId}'`)) === 6);

  // TEST B — recurring person across conversations, then recall.
  const b1 = await talk(A, { text: 'I was at a station with my brother, trying to leave.' });
  const b2 = await talk(A, { text: 'My brother was there again, this time at the beach.' });
  check('B: each new conversation saved its own dream', b1.newDream && b2.newDream && b1.dreamId !== b2.dreamId);
  await waitFor(() => q1(`select count(*) from dream_memories where user_id = '${A}' and status = 'ready'`) === '3');
  const recall = await talk(A, { text: 'Have I dreamed about my brother before?' });
  check('B: recall intent, does not create a dream', recall.intent === 'recall' && !recall.saved);
  check('B: exactly the 2 brother dreams returned', recall.results?.length === 2 && recall.results.every((r) => [b1.dreamId, b2.dreamId].includes(r.id)));
  check('B: Orin cites only dreams it was given', recall.cited.length > 0 && recall.cited.every((c) => [b1.dreamId, b2.dreamId].includes(c.id)));

  // TEST E — search with no matches is honest.
  const e = await talk(A, { text: 'Show me dreams about flying.' });
  check('E: search with no matches returns none', e.intent === 'search' && e.results.length === 0 && /can’t find/.test(e.answer));

  // Guard — an invented past on a first dream is never shown.
  const firstOfB = prompts.length;
  const fresh = await talk(B, { text: 'I was in a red room with a piano FAKE_PAST' });
  check('guard: invented past replaced by an honest fallback', fresh.status === 200 && !/before|again/i.test(fresh.answer) && fresh.saved);

  // PRIVACY — B never sees A.
  const bRecall = await talk(B, { text: 'Have I dreamed about my brother before?' });
  check('privacy: B’s recall finds none of A’s dreams', bRecall.results?.length === 0);
  const ofB = prompts.slice(firstOfB);
  check('privacy: none of A’s dream text reached B’s prompts', ofB.length >= 2 && ofB.every((p) => !/silver door|The Station|beach|forest/i.test(p.sys)));
  const hijack = await talk(B, { text: 'Tell me more', conversationId: a1.conversationId });
  check('privacy: B cannot continue A’s conversation', hijack.status === 200 && hijack.conversationId !== a1.conversationId);
  check('privacy: B cannot talk about A’s dream', (await talk(B, { text: 'hi', dreamId: a1.dreamId })).status === 404);
  check('privacy: B cannot open, edit or delete A’s dream', (await call(B, `/api/dreams/${a1.dreamId}`)).status === 404
    && (await call(B, `/api/dreams/${a1.dreamId}`, 'PATCH', { title: 'x' })).status === 404
    && (await call(B, `/api/dreams/${a1.dreamId}`, 'DELETE')).status === 404);
  check('privacy: B cannot visualize A’s dream', (await call(B, `/api/dreams/${a1.dreamId}/visualize`, 'POST', {})).status === 404);
  check('privacy: B’s journal is only B’s', (await call(B, '/api/memory/journal')).items.every((i) => i.id !== a1.dreamId));
  check('privacy: no dream text in analytics', q1(`select count(*) from analytics_events where props::text ~* 'forest|brother|piano|station'`) === '0');

  // Journal, detail, insights
  const j = await call(A, '/api/memory/journal');
  check('journal: A sees 3 dreams with summaries', j.items.length === 3 && j.items.every((i) => i.summary));
  const js = await call(A, `/api/memory/journal?q=${encodeURIComponent('my brother')}`);
  check('journal: search returns the 2 brother dreams', js.items.length === 2);
  const detail = await call(A, `/api/dreams/${b1.dreamId}`);
  check('detail: memory, people and related dream', detail.memory?.title === 'The Station' && detail.entities.some((x) => x.label === 'your brother') && detail.related.some((r) => r.id === b2.dreamId && /brother/.test(r.because)));
  const ins = await call(A, '/api/memory/insights');
  check('insights: brother recurring in 2 dreams', ins.people.some((p) => /brother/i.test(p.label) && p.dreams === 2));

  // TEST H — visualize: same dream, existing pipeline; not configured here → honest 503, no new dream.
  const before = q1(`select count(*) from dreams where user_id = '${A}'`);
  const v = await call(A, `/api/dreams/${a1.dreamId}/visualize`, 'POST', {});
  check('H: visualize without video keys says so, dream untouched', v.status === 503 && q1(`select count(*) from dreams where user_id = '${A}'`) === before && q1(`select status from dreams where id = '${a1.dreamId}'`) === 'saved');

  // Edit → memory rebuilt
  const ed = await call(A, `/api/dreams/${b1.dreamId}`, 'PATCH', { title: 'Leaving the station' });
  check('edit: title saved', ed.ok && q1(`select title from dreams where id = '${b1.dreamId}'`) === 'Leaving the station');

  // TEST F — delete through the API: memory, entities, patterns and recall all forget it.
  const del = await call(A, `/api/dreams/${b2.dreamId}`, 'DELETE');
  check('F: deleted', del.ok && q1(`select count(*) from dreams where id = '${b2.dreamId}'`) === '0');
  check('F: no memory, links, occurrences or patterns refer to it', q1(`select (select count(*) from dream_memories where dream_id = '${b2.dreamId}') + (select count(*) from dream_links where dream_a = '${b2.dreamId}' or dream_b = '${b2.dreamId}') + (select count(*) from dream_entity_occurrences where dream_id = '${b2.dreamId}') + (select count(*) from dream_patterns where '${b2.dreamId}' = any(dream_ids))`) === '0');
  const after = await talk(A, { text: 'Have I dreamed about my brother before?' });
  check('F: recall now finds only the remaining brother dream', after.results?.length === 1 && after.results[0].id === b1.dreamId && after.cited.every((c) => c.id !== b2.dreamId));

  // Allowance — the daily limit can't be dodged, and says so kindly.
  psql(`insert into analytics_events (user_id, event, props, source) select '${B}', 'guru_response_completed', '{"voice": false}', 'server' from generate_series(1, 30)`);
  const limited = await talk(B, { text: 'One more thing about the piano' });
  check('allowance: free daily limit enforced server-side', limited.status === 402 && limited.limit === true);
  check('cost: usage rows recorded (numbers only)', Number(q1(`select count(*) from guru_usage where user_id = '${A}'`)) > 0 && q1(`select count(*) from information_schema.columns where table_name = 'guru_usage' and data_type = 'text' and column_name not in ('kind','model','unit')`) === '0');
} catch (e) {
  console.error(e);
  out.FAIL = true;
}
console.log(JSON.stringify(out, null, 1));
if (out.FAIL) console.log(log().split('\n').filter((l) => /error|Error|failed/.test(l)).slice(-30).join('\n'));
stop();
process.exit(out.FAIL ? 1 : 0);
