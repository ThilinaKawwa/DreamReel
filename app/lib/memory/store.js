// Reads and writes the three memory levels for ONE signed-in person. Server only.
// `db` is the Supabase client acting AS that person (row level security applies), and every
// query ALSO filters by their user id — RLS is the backstop, not the only check.
import { models } from '../models.js';
import { MEMORY_VERSION, MEMORY_SYSTEM, normalizeMemory, memoryInput, sourceHash, followUpsFrom } from './normalize.js';
import { entityCandidates, matchEntity } from './entities.js';
import { detectPatterns, relateDreams, LINK_THRESHOLD } from './patterns.js';

const INDEX_FIELDS = 'dream_id, dream_at, title, summary, cleaned_text, emotions, themes, people, places, objects, creatures, dream_type, status';
const STUCK_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;

/**
 * Compact memory of up to `limit` recent dreams. Dreams whose memory isn't built yet (or failed)
 * are still included from their own words, so nothing the person said is ever unsearchable.
 */
export async function loadIndex(db, userId, limit = 300) {
  const [{ data: mems }, { data: dreams }] = await Promise.all([
    db.from('dream_memories').select(INDEX_FIELDS).eq('user_id', userId).order('dream_at', { ascending: false }).limit(limit),
    db.from('dreams').select('id, created_at, title, transcript, status').eq('user_id', userId).in('status', ['ready', 'saved'])
      .order('created_at', { ascending: false }).limit(limit),
  ]);
  const ready = new Map((mems || []).filter((m) => m.status === 'ready').map((m) => [m.dream_id, m]));
  return (dreams || []).map((d) => ready.get(d.id) ? { ...ready.get(d.id), dream_at: d.created_at } : {
    dream_id: d.id, dream_at: d.created_at, title: d.title, summary: clip(d.transcript, 160), cleaned_text: clip(d.transcript, 1200),
    emotions: [], themes: [], people: [], places: [], objects: [], creatures: [], dream_type: null, pending: true,
  });
}

export async function loadEntityStats(db, userId) {
  const { data } = await db.from('dream_entity_stats').select('*').eq('user_id', userId).gt('appearances', 0)
    .order('appearances', { ascending: false }).limit(400);
  return data || [];
}

/** { dream_id: [{entity_id, confidence, emotion}] } */
export async function loadOccurrences(db, userId) {
  const { data } = await db.from('dream_entity_occurrences').select('entity_id, dream_id, confidence, emotion').eq('user_id', userId).limit(5000);
  const by = {};
  for (const o of data || []) (by[o.dream_id] ||= []).push(o);
  return by;
}

export async function loadPatterns(db, userId, liveIds = null) {
  const { data } = await db.from('dream_patterns').select('pattern_key, pattern_type, description, dream_ids, strength, confidence, first_detected, updated_at')
    .eq('user_id', userId).order('strength', { ascending: false }).limit(60);
  // Defensive: a pattern only ever stands on dreams that still exist.
  return (data || []).map((p) => (liveIds ? { ...p, dream_ids: p.dream_ids.filter((id) => liveIds.has(id)) } : p))
    .filter((p) => !liveIds || p.dream_ids.length >= 2);
}

/** Dreams counted this week / month / overall (from the dreams table — the source of truth). */
export async function activity(db, userId) {
  const now = Date.now();
  const since = (d) => new Date(now - d * 86400000).toISOString();
  const count = (q) => q.then(({ count: c }) => c || 0, () => 0);
  const base = () => db.from('dreams').select('id', { count: 'exact', head: true }).eq('user_id', userId).in('status', ['ready', 'saved']);
  const [total, week, month] = await Promise.all([count(base()), count(base().gte('created_at', since(7))), count(base().gte('created_at', since(30)))]);
  return { total, week, month };
}

/**
 * Builds (or rebuilds) one dream's memory: Level 1 record, Level 2 entity occurrences,
 * related-dream links, then Level 3 patterns. The dream itself is never touched except to
 * give an untitled dream its title. Returns 'built' | 'fresh' | 'skipped'. Throws on failure
 * (the caller records it and the dream stays safely saved).
 */
export async function buildMemory(db, openai, { userId, dreamId, bible = null, onUsage = () => {} }) {
  const { data: dream } = await db.from('dreams').select('id, user_id, created_at, title, transcript, status, source')
    .eq('id', dreamId).eq('user_id', userId).maybeSingle();
  if (!dream || !String(dream.transcript || '').trim()) return 'skipped';
  const { data: msgs } = await db.from('guru_messages').select('role, content, intent, created_at')
    .eq('dream_id', dreamId).eq('user_id', userId).order('created_at', { ascending: true }).limit(40);
  const followUps = followUpsFrom(msgs || []);
  const hash = sourceHash(dream.transcript, followUps);
  const { data: existing } = await db.from('dream_memories').select('status, source_hash, memory_version, attempts')
    .eq('dream_id', dreamId).eq('user_id', userId).maybeSingle();
  if (existing?.status === 'ready' && existing.source_hash === hash && existing.memory_version === MEMORY_VERSION) return 'fresh';

  const attempts = (existing?.attempts || 0) + 1;
  await db.from('dream_memories').upsert({
    dream_id: dreamId, user_id: userId, dream_at: dream.created_at, status: 'pending', attempts, updated_at: new Date().toISOString(),
  }, { onConflict: 'dream_id' });

  try {
    const model = models().memory;
    const completion = await openai.chat.completions.create({
      model, temperature: 0.2, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: MEMORY_SYSTEM }, { role: 'user', content: memoryInput({ transcript: dream.transcript, followUps, bible }) }],
    });
    onUsage({ kind: 'memory', model, usage: completion.usage });
    const memory = normalizeMemory(JSON.parse(completion.choices[0].message.content || '{}'));
    // Orin's reflection from the capture conversation (his last substantive reply about this dream).
    const reflection = [...(msgs || [])].reverse().find((m) => m.role === 'assistant' && m.content.length > 80)?.content || null;

    const { error } = await db.from('dream_memories').upsert({
      dream_id: dreamId, user_id: userId, dream_at: dream.created_at, status: 'ready', memory_version: MEMORY_VERSION,
      source_hash: hash, attempts, error: null, ...memory, follow_ups: followUps, reflection: clip(reflection, 1200),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'dream_id' });
    if (error) throw new Error(`save memory: ${error.message}`);
    if (!dream.title) await db.from('dreams').update({ title: memory.title }).eq('id', dreamId).eq('user_id', userId);

    await linkEntities(db, userId, dreamId, memory);
    await linkRelated(db, userId, dreamId);
    await recomputePatterns(db, userId);
    return 'built';
  } catch (e) {
    await db.from('dream_memories').update({ status: 'failed', error: String(e?.message || e).slice(0, 200), updated_at: new Date().toISOString() })
      .eq('dream_id', dreamId).eq('user_id', userId);
    throw e;
  }
}

/** Level 2: this dream's people/places/objects/creatures, matched to earlier ones (matchEntity). */
async function linkEntities(db, userId, dreamId, memory) {
  await db.from('dream_entity_occurrences').delete().eq('dream_id', dreamId).eq('user_id', userId);
  const { data: known } = await db.from('dream_entities').select('id, entity_type, norm_key, specific, aliases').eq('user_id', userId).limit(2000);
  const existing = known || [];
  for (const c of entityCandidates(memory)) {
    const hit = matchEntity(c, existing);
    let ent = hit?.entity;
    if (!ent) {
      const ins = await db.from('dream_entities').insert({
        user_id: userId, entity_type: c.type, norm_key: c.key, label: c.label, aliases: [c.mention], specific: c.specific,
      }).select('id, entity_type, norm_key, specific, aliases').maybeSingle();
      ent = ins.data;
      if (!ent) { // created at the same moment by another request
        ({ data: ent } = await db.from('dream_entities').select('id, entity_type, norm_key, specific, aliases').eq('user_id', userId).eq('entity_type', c.type).eq('norm_key', c.key).maybeSingle());
      }
      if (!ent) continue;
      existing.push(ent);
    } else if (!ent.aliases.includes(c.mention) && ent.aliases.length < 12) {
      ent.aliases = [...ent.aliases, c.mention];
      await db.from('dream_entities').update({ aliases: ent.aliases, updated_at: new Date().toISOString() }).eq('id', ent.id).eq('user_id', userId);
    }
    await db.from('dream_entity_occurrences').upsert({
      entity_id: ent.id, dream_id: dreamId, user_id: userId, mention: c.mention, emotion: c.emotion,
      confidence: hit ? hit.confidence : c.confidence,
    }, { onConflict: 'entity_id,dream_id' });
  }
}

/** Related / possibly recurring dreams: scored pairs with reasons. */
async function linkRelated(db, userId, dreamId) {
  const [index, occ, stats] = await Promise.all([loadIndex(db, userId, 300), loadOccurrences(db, userId), loadEntityStats(db, userId)]);
  const me = index.find((m) => m.dream_id === dreamId);
  if (!me) return;
  const entities = new Map(stats.map((e) => [e.id, e]));
  const links = index.filter((m) => m.dream_id !== dreamId && !m.pending)
    .map((m) => ({ m, r: relateDreams(me, m, occ[dreamId] || [], occ[m.dream_id] || [], entities) }))
    .filter((x) => x.r.score >= LINK_THRESHOLD)
    .sort((a, b) => b.r.score - a.r.score).slice(0, 8)
    .map(({ m, r }) => {
      const [a, b] = [dreamId, m.dream_id].sort();
      return { user_id: userId, dream_a: a, dream_b: b, score: r.score, reasons: r.reasons };
    });
  await db.from('dream_links').delete().eq('user_id', userId).or(`dream_a.eq.${dreamId},dream_b.eq.${dreamId}`);
  if (links.length) await db.from('dream_links').upsert(links, { onConflict: 'dream_a,dream_b' });
}

/** Level 3: rebuilds the pattern cache from levels 1–2. Cheap (no AI). */
export async function recomputePatterns(db, userId) {
  const [index, stats] = await Promise.all([loadIndex(db, userId, 500), loadEntityStats(db, userId)]);
  const found = detectPatterns(index, stats);
  const now = new Date().toISOString();
  if (found.length) {
    await db.from('dream_patterns').upsert(found.map((p) => ({
      user_id: userId, pattern_key: p.pattern_key, pattern_type: p.pattern_type, description: p.description,
      dream_ids: p.dream_ids, strength: p.strength, confidence: p.confidence, updated_at: now,
    })), { onConflict: 'user_id,pattern_key' });
  }
  const keep = new Set(found.map((p) => p.pattern_key));
  const { data: old } = await db.from('dream_patterns').select('id, pattern_key').eq('user_id', userId);
  const stale = (old || []).filter((p) => !keep.has(p.pattern_key)).map((p) => p.id);
  if (stale.length) await db.from('dream_patterns').delete().eq('user_id', userId).in('id', stale);
  return found.length;
}

/** After a dream is deleted: drop entities nothing refers to any more, rebuild patterns. */
export async function forgetDream(db, userId) {
  const { data: empty } = await db.from('dream_entity_stats').select('id').eq('user_id', userId).eq('appearances', 0).limit(500);
  const ids = (empty || []).map((e) => e.id);
  if (ids.length) await db.from('dream_entities').delete().eq('user_id', userId).in('id', ids);
  await recomputePatterns(db, userId);
}

/** Marks a dream's memory out of date (after an edit or a new capture turn). */
export async function markStale(db, userId, dreamId) {
  await db.from('dream_memories').update({ status: 'pending', attempts: 0, updated_at: new Date().toISOString() })
    .eq('dream_id', dreamId).eq('user_id', userId);
}

/**
 * Dreams whose memory is missing, out of date, stuck or failed (with tries left).
 * Used to retry derived processing — and to build memories for dreams made before V2.
 */
export async function dreamsNeedingMemory(db, userId, max = 2) {
  const [{ data: dreams }, { data: mems }] = await Promise.all([
    db.from('dreams').select('id, created_at, updated_at, status, transcript').eq('user_id', userId).in('status', ['ready', 'saved'])
      .order('created_at', { ascending: false }).limit(60),
    db.from('dream_memories').select('dream_id, status, attempts, updated_at').eq('user_id', userId).limit(500),
  ]);
  const byId = new Map((mems || []).map((m) => [m.dream_id, m]));
  const now = Date.now();
  return (dreams || []).filter((d) => {
    if (!String(d.transcript || '').trim()) return false;
    const m = byId.get(d.id);
    if (!m) return now - new Date(d.updated_at || d.created_at).getTime() > 90 * 1000; // give a live capture a moment
    const age = now - new Date(m.updated_at).getTime();
    if (m.status === 'failed') return m.attempts < MAX_ATTEMPTS && age > 2 * 60 * 1000;
    if (m.status === 'pending') return m.attempts < MAX_ATTEMPTS + 2 && (m.attempts === 0 ? age > 90 * 1000 : age > STUCK_MS);
    return false;
  }).slice(0, max).map((d) => d.id);
}

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t || null;
};
