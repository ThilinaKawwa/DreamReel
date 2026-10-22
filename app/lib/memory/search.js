// DREAM RETRIEVAL — ranking stored dream memories against what the dreamer just said. Pure.
// Combines entity overlap, literal motifs, keywords and recency. No embeddings in V2: this
// is predictable, cheap and testable; see docs/guru-v2.md for the pgvector upgrade path.
import { normKey, findMentions } from './entities.js';

// Literal dream motifs and the words people use for them.
export const MOTIFS = {
  water: ['water', 'sea', 'ocean', 'river', 'lake', 'flood', 'flooding', 'waves', 'wave', 'swim', 'swimming', 'drowning', 'drown', 'rain', 'tide', 'pool'],
  flying: ['fly', 'flying', 'flew', 'floating', 'float', 'hovering', 'soaring'],
  falling: ['fall', 'falling', 'fell', 'dropping'],
  'being chased': ['chased', 'chasing', 'chase', 'pursued', 'running away', 'hunted'],
  'being late': ['late', 'missed', 'missing the', 'running late'],
  teeth: ['teeth', 'tooth'],
  death: ['died', 'dead', 'death', 'dying', 'funeral'],
  'being lost': ['lost', 'couldn\'t find', 'could not find', 'searching', 'looking for'],
  exams: ['exam', 'exams'],
  fire: ['fire', 'burning', 'flames'],
  trains: ['train', 'trains', 'station', 'platform', 'railway'],
  houses: ['house', 'home', 'room', 'rooms', 'corridor', 'hallway'],
};

const STOP = new Set('a an the and or but if of to in on at for with about from by is was were be been am are i me my we our you your he she they it this that these those there here have has had do did does dream dreams dreamed dreamt dreaming ever again before show find tell list when what which who how many much times last time any all some about like just really kind sort of get got go went come came see saw'.split(' '));

const days = (iso, now) => Math.max(0, (now - new Date(iso).getTime()) / 86400000);

/** Words, motifs, time range and known entities in a question or a dream description. */
export function parseQuery(text, entities = [], now = Date.now()) {
  const lower = String(text || '').toLowerCase();
  const terms = [...new Set(lower.replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)))].slice(0, 20);
  const motifs = Object.entries(MOTIFS).filter(([name, ws]) => lower.includes(name) || ws.some((w) => new RegExp(`\\b${w}\\b`).test(lower))).map(([n]) => n);
  let since = null;
  const day = 86400000;
  if (/\bthis week\b/.test(lower)) since = now - 7 * day;
  else if (/\blast week\b/.test(lower)) since = now - 14 * day;
  else if (/\bthis month\b/.test(lower)) since = now - 31 * day;
  else if (/\blast month\b/.test(lower)) since = now - 62 * day;
  else if (/\b(recently|lately)\b/.test(lower)) since = now - 21 * day;
  return { terms, motifs, since, entities: findMentions(lower, entities) };
}

/** Motifs present in one stored memory (its themes plus the words in its text). */
export function memoryMotifs(m) {
  const text = `${m.title || ''} ${m.summary || ''} ${m.cleaned_text || ''} ${(m.themes || []).join(' ')}`.toLowerCase();
  return Object.entries(MOTIFS).filter(([name, ws]) => (m.themes || []).includes(name) || ws.some((w) => new RegExp(`\\b${w}\\b`).test(text))).map(([n]) => n);
}

/**
 * Scores each memory against a parsed query.
 * index: [{dream_id, dream_at, title, summary, cleaned_text, themes, emotions, people, places, objects, creatures}]
 * occurrences: { [dream_id]: [{entity_id, confidence}] }
 */
export function rankMemories(index, query, { occurrences = {}, exclude = null, now = Date.now() } = {}) {
  const wanted = new Map(query.entities.map((e) => [e.id, e]));
  return (index || [])
    .filter((m) => m.dream_id !== exclude && (!query.since || new Date(m.dream_at).getTime() >= query.since))
    .map((m) => {
      const why = [];
      let score = 0;
      for (const o of occurrences[m.dream_id] || []) {
        const e = wanted.get(o.entity_id);
        if (!e) continue;
        score += e.specific ? 3 : 2;
        why.push({ kind: e.entity_type, label: e.label, sameness: o.confidence >= 0.8 ? 'same' : 'similar' });
      }
      const motifs = memoryMotifs(m).filter((x) => query.motifs.includes(x));
      if (motifs.length) { score += 2 * motifs.length; motifs.forEach((x) => why.push({ kind: 'theme', label: x })); }
      const hay = `${m.title || ''} ${m.summary || ''} ${m.cleaned_text || ''} ${labels(m).join(' ')}`.toLowerCase();
      const termHits = query.terms.filter((t) => hay.includes(t) || hay.includes(normKey(t))).length;
      score += Math.min(termHits, 4) * 0.75;
      if (score > 0) score += 0.5 * Math.exp(-days(m.dream_at, now) / 30);
      return { memory: m, score: Math.round(score * 100) / 100, why };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || new Date(b.memory.dream_at) - new Date(a.memory.dream_at));
}

/** Every dream that genuinely matches a search question (for "show me…", "how many…"). */
export function searchArchive(index, query, opts = {}) {
  const hasSubject = query.entities.length || query.motifs.length || query.terms.length;
  const pool = hasSubject ? rankMemories(index, query, opts).filter((r) => r.score >= 1.4) : (index || [])
    .filter((m) => !query.since || new Date(m.dream_at).getTime() >= query.since)
    .map((m) => ({ memory: m, score: 0, why: [] }));
  const matches = pool.sort((a, b) => new Date(b.memory.dream_at) - new Date(a.memory.dream_at));
  return { count: matches.length, matches, latest: matches[0] || null };
}

/** The few past dreams worth putting in front of Orin right now. */
export function relevantMemories(index, query, { limit = 4, ...opts } = {}) {
  return rankMemories(index, query, opts).slice(0, limit);
}

export function labels(m) {
  return ['people', 'places', 'objects', 'creatures'].flatMap((k) => (m[k] || []).map((x) => (typeof x === 'string' ? x : x.label))).filter(Boolean);
}
