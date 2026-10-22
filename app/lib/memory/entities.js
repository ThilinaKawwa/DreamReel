// ENTITY MEMORY — recurring people, places, objects and creatures across dreams. Pure.
//
// The rule: never assume two similar things are the same. "My brother" is very likely the
// same person each time (high confidence). "My grandmother's house" is one specific place.
// "A train station" is counted under 'train station' so Orin can say a station has
// appeared before — but with low confidence, so he never claims it was the SAME station.

export const ENTITY_TYPES = ['person', 'place', 'object', 'creature'];

// Family words people use for the same relative.
const KIN = {
  mother: ['mum', 'mom', 'mummy', 'mommy', 'mother', 'ma', 'mam'],
  father: ['dad', 'daddy', 'father', 'papa', 'pa'],
  brother: ['brother', 'bro'],
  sister: ['sister', 'sis'],
  grandmother: ['grandmother', 'grandma', 'gran', 'granny', 'nan', 'nana', 'nanna'],
  grandfather: ['grandfather', 'grandpa', 'grandad', 'granddad', 'gramps'],
  son: ['son'], daughter: ['daughter'],
  partner: ['partner', 'boyfriend', 'girlfriend', 'husband', 'wife', 'fiance', 'fiancee', 'spouse'],
  aunt: ['aunt', 'auntie', 'aunty'], uncle: ['uncle'], cousin: ['cousin'],
  baby: ['baby'],
};
const KIN_LOOKUP = Object.fromEntries(Object.entries(KIN).flatMap(([k, words]) => words.map((w) => [w, k])));

const FILLER = new Set(['a', 'an', 'the', 'some', 'this', 'that', 'my', 'our', 'your', 'his', 'her', 'their', 'old', 'big', 'small', 'little', 'kind', 'of', 'sort', 'like', 'weird', 'strange']);
// Words that make a place or thing one particular place or thing.
const SPECIFIC = /\b(my|our|childhood|grandmother'?s?|grandma'?s?|grandparents'?|parents'?|mum'?s|mom'?s|dad'?s|home|school|primary school|secondary school|university|office|work|flat|apartment)\b/i;

/** "My older Brother!" → "brother"; "the old train station" → "train station". */
export function normKey(label, type = 'object') {
  const words = String(label || '').toLowerCase()
    .replace(/[’']s\b/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/).filter(Boolean);
  if (type === 'person') {
    const kin = words.map((w) => KIN_LOOKUP[w]).find(Boolean);
    if (kin) return kin;
  }
  const kept = words.filter((w) => !FILLER.has(w) && !['older', 'younger', 'elder', 'big', 'little'].includes(w));
  const key = (kept.length ? kept : words).map(singular).join(' ').slice(0, 60);
  return key;
}

function singular(w) {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

/** Is this label about one particular person/place/thing (rather than "a station")? */
export function isSpecific(label, type) {
  const s = String(label || '');
  if (type === 'person') {
    const words = s.toLowerCase().split(/[^a-z]+/);
    if (words.some((w) => KIN_LOOKUP[w])) return true;           // relatives
    if (/\b(my|our)\b/i.test(s)) return true;                     // my friend Sam, my boss
    if (/\b[A-Z][a-z]{2,}\b/.test(s.replace(/^(A|An|The|My)\b/, ''))) return true; // a name
    return false;                                                 // "a woman", "a stranger"
  }
  return SPECIFIC.test(s);
}

/** How Orin refers to it: "your brother", "a train station", "your grandmother's house". */
export function displayLabel(label, type, specific) {
  const key = normKey(label, type);
  if (type === 'person' && KIN[key]) return `your ${key}`;
  const clean = String(label || key).trim().replace(/\s+/g, ' ').slice(0, 60);
  if (/^(my|our)\b/i.test(clean)) return clean.replace(/^my\b/i, 'your').replace(/^our\b/i, 'your');
  if (specific) return clean;
  return clean.replace(/^(the|a|an)\s+/i, '');
}

/**
 * Candidate entities in one dream memory → [{type, key, label, specific, mention, emotion, confidence}].
 * Confidence = how likely this is the same entity as an earlier one with the same key.
 */
export function entityCandidates(memory) {
  const out = [];
  const seen = new Set();
  const groups = { person: memory.people, place: memory.places, object: memory.objects, creature: memory.creatures };
  for (const [type, list] of Object.entries(groups)) {
    for (const item of Array.isArray(list) ? list : []) {
      const label = typeof item === 'string' ? item : item?.label;
      if (!label || /^(i|me|myself|the dreamer|dreamer)$/i.test(label.trim())) continue;
      const key = normKey(label, type);
      if (!key || key.length < 2 || seen.has(`${type}:${key}`)) continue;
      seen.add(`${type}:${key}`);
      const specific = isSpecific(label, type) || Boolean(item?.familiar);
      out.push({
        type, key, specific,
        label: displayLabel(label, type, specific),
        mention: String(label).slice(0, 80),
        emotion: (typeof item === 'object' && item?.emotion ? String(item.emotion) : memory.emotions?.[0] || null)?.slice(0, 30) || null,
        confidence: confidenceFor(type, key, specific),
      });
    }
  }
  return out.slice(0, 24);
}

/**
 * Which stored entity is this candidate? existing: [{id, entity_type, norm_key, specific}].
 * Same key → that entity. Otherwise a GENERIC thing may join a generic entity with the same
 * head noun ("the station" ↔ "a train station"), but only with low confidence ("similar").
 * Specific people/places never merge on a guess.
 */
export function matchEntity(candidate, existing) {
  const same = (existing || []).find((e) => e.entity_type === candidate.type && e.norm_key === candidate.key);
  if (same) return { entity: same, confidence: candidate.confidence };
  if (candidate.specific || candidate.type === 'person') return null;
  const head = (k) => k.split(' ').pop();
  const near = (existing || []).find((e) => e.entity_type === candidate.type && !e.specific && head(e.norm_key) === head(candidate.key) && head(candidate.key).length > 3);
  return near ? { entity: near, confidence: Math.min(candidate.confidence, 0.5) } : null;
}

export function confidenceFor(type, key, specific) {
  if (type === 'person' && KIN[key]) return 0.9;   // "my brother" — almost always the same person
  if (specific) return 0.8;                       // "my grandmother's house"
  if (type === 'person') return 0.35;             // "a woman" — probably different people
  return 0.55;                                    // "a station", "a dog" — same kind, maybe not the same one
}

/** Same-entity language Orin may use for an entity seen before. */
export function sameness(confidence) {
  if (confidence >= 0.8) return 'same';       // "your brother appeared again"
  if (confidence >= 0.5) return 'similar';    // "a station has appeared before — was it the same place?"
  return 'kind';                              // "another stranger"
}

/**
 * Which known entities does this text mention? Cheap lexical match used for retrieval
 * before a dream's memory has been built. entities: [{id, entity_type, norm_key, aliases}]
 */
export function findMentions(text, entities) {
  const t = ` ${String(text || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ')} `;
  const hits = [];
  for (const e of entities || []) {
    const keys = new Set([e.norm_key, ...(e.aliases || []).map((a) => normKey(a, e.entity_type))]);
    if (e.entity_type === 'person' && KIN[e.norm_key]) KIN[e.norm_key].forEach((w) => keys.add(w));
    for (const k of keys) {
      if (!k || k.length < 3) continue;
      const pattern = k.split(' ').map((w) => `${escape(w)}(s|es)?`).join(' ');
      if (new RegExp(` ${pattern}[ ']`).test(t)) { hits.push(e); break; }
    }
  }
  return hits;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
