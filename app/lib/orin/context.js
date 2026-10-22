// GuruContext: the small, structured picture of the dreamer's history Orin sees each turn.
// Built from retrieved rows — never a database dump, never every transcript. Pure.
import { sameness } from '../memory/entities.js';

const MAX_DREAM_TEXT = 2500;
const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' });
const clip = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ''));

/**
 * @param {object} p
 * @param {object|null} p.currentDream   { id, transcript, title, created_at, memory? }
 * @param {Array} p.relevant             rankMemories() results [{memory, score, why}]
 * @param {object|null} p.archive        searchArchive() result, for history questions
 * @param {Array} p.entities             dream_entity_stats rows relevant to this turn
 * @param {Array} p.patterns             dream_patterns rows relevant to this turn
 * @param {object} p.activity            { total, week, month }
 */
export function buildGuruContext({ currentDream = null, relevant = [], archive = null, entities = [], patterns = [], activity = { total: 0, week: 0, month: 0 } }) {
  const refs = new Map(); // 'D1' → dream id (the only ids Orin may cite)
  const ref = (id) => {
    for (const [k, v] of refs) if (v === id) return k;
    const k = `D${refs.size + 1}`;
    refs.set(k, id);
    return k;
  };
  const brief = (m, why = []) => ({
    ref: ref(m.dream_id), id: m.dream_id, date: fmtDate(m.dream_at), title: m.title || 'Untitled dream',
    summary: clip(m.summary, 200), feelings: (m.emotions || []).slice(0, 3), why,
  });
  const past = relevant.filter((r) => r.memory.dream_id !== currentDream?.id).slice(0, 4).map((r) => brief(r.memory, r.why));
  const found = archive ? archive.matches.slice(0, 12).map((r) => brief(r.memory, r.why)) : null;
  const history = activity.total - (currentDream ? 1 : 0);
  return {
    firstDream: history <= 0,
    activity,
    currentDream: currentDream ? {
      date: fmtDate(currentDream.created_at),
      title: currentDream.memory?.title || currentDream.title || null,
      text: clip(currentDream.transcript, MAX_DREAM_TEXT),
      summary: currentDream.memory?.summary || null,
      feelings: currentDream.memory?.emotions || [],
    } : null,
    memories: past,
    archive: archive ? { count: archive.count, items: found } : null,
    entities: entities.filter((e) => e.appearances > 0).slice(0, 6).map((e) => ({
      label: e.label, type: e.entity_type, dreams: e.appearances, sameness: sameness(e.specific ? Math.max(e.confidence, 0.8) : e.confidence),
      lastSeen: e.last_seen ? fmtDate(e.last_seen) : null,
    })),
    patterns: patterns.slice(0, 4).map((p) => p.description),
    refs,
  };
}

/** The context as compact text for the model. */
export function renderContext(ctx) {
  const out = [];
  if (ctx.currentDream) {
    out.push(`CURRENT DREAM (recorded ${ctx.currentDream.date}; their own words, saved):\n"""${ctx.currentDream.text}"""`);
  }
  if (ctx.memories.length) {
    out.push(`MEMORY — earlier dreams from their journal that may be relevant (cite only these, by id):\n${ctx.memories.map(line).join('\n')}`);
  } else {
    out.push(ctx.firstDream
      ? 'MEMORY: no earlier dreams are saved. This is the start of their dream journal.'
      : 'MEMORY: none of their earlier dreams seem related to this. Do not refer to the past.');
  }
  if (ctx.archive) {
    out.push(ctx.archive.count
      ? `ARCHIVE RESULTS for their question — ${ctx.archive.count} matching dream${ctx.archive.count === 1 ? '' : 's'} (newest first${ctx.archive.count > ctx.archive.items.length ? `, first ${ctx.archive.items.length} shown` : ''}):\n${ctx.archive.items.map(line).join('\n')}`
      : 'ARCHIVE RESULTS for their question: no matching dreams in their journal.');
  }
  if (ctx.entities.length) {
    out.push(`RECURRING in their journal:\n${ctx.entities.map((e) => `- ${e.label} (${e.type}): ${e.dreams} dream${e.dreams === 1 ? '' : 's'}${e.lastSeen ? `, last ${e.lastSeen}` : ''}${e.sameness === 'same' ? '' : ' — may not be the same one each time'}`).join('\n')}`);
  }
  if (ctx.patterns.length) out.push(`PATTERNS observed (counts from stored dreams):\n${ctx.patterns.map((p) => `- ${p}`).join('\n')}`);
  out.push(`ACTIVITY: ${ctx.activity.total} dream${ctx.activity.total === 1 ? '' : 's'} saved in total; ${ctx.activity.week} in the last 7 days; ${ctx.activity.month} in the last 30 days.`);
  return out.join('\n\n');
}

function line(d) {
  const why = d.why?.length ? ` | shares: ${d.why.map((w) => `${w.label}${w.sameness === 'similar' ? ' (similar, maybe not the same)' : ''}`).join(', ')}` : '';
  return `- [${d.ref}] ${d.date} "${d.title}": ${d.summary}${d.feelings.length ? ` | felt: ${d.feelings.join(', ')}` : ''}${why}`;
}
