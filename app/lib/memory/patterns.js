// PATTERN MEMORY — level 3: what repeats across the dreamer's history. Pure.
// Patterns are COUNTS over stored dreams, worded carefully. No causes, no diagnoses.
import { memoryMotifs } from './search.js';

const MIN_SUPPORT = 2;

/**
 * @param {Array} index        dream memories [{dream_id, dream_at, emotions, themes, ...}]
 * @param {Array} entityStats  rows of dream_entity_stats [{id, entity_type, label, specific, appearances, dream_ids, emotions, confidence}]
 * @returns {Array<{pattern_key, pattern_type, description, dream_ids, strength, confidence}>}
 */
export function detectPatterns(index, entityStats, now = Date.now()) {
  const live = new Set((index || []).map((m) => m.dream_id));
  const total = live.size;
  const out = [];

  // Recurring people, places, objects, creatures
  for (const e of entityStats || []) {
    const ids = (e.dream_ids || []).filter((id) => live.has(id));
    if (ids.length < MIN_SUPPORT) continue;
    const kind = { person: 'person', place: 'place', object: 'object', creature: 'creature' }[e.entity_type];
    const sure = e.specific && e.confidence >= 0.75;
    out.push({
      pattern_key: `entity:${e.entity_type}:${e.norm_key}`,
      pattern_type: 'recurring_entity',
      description: sure
        ? `${cap(e.label)} appeared in ${ids.length} of ${total} dreams.`
        : `A ${e.norm_key} appeared in ${ids.length} of ${total} dreams (possibly not the same ${kind} each time).`,
      dream_ids: ids,
      strength: ids.length,
      confidence: round(Math.min(0.95, (sure ? 0.6 : 0.4) + 0.08 * ids.length)),
      label: e.label,
      entity_type: e.entity_type,
    });

    // The feeling that tends to come with it — only when it clearly dominates.
    const feelings = (e.emotions || []).filter(Boolean);
    const top = mode(feelings);
    if (ids.length >= 3 && top && top.count / ids.length >= 0.6) {
      out.push({
        pattern_key: `entity_emotion:${e.entity_type}:${e.norm_key}:${top.value}`,
        pattern_type: 'entity_emotion',
        description: `In ${top.count} of the ${ids.length} dreams with ${e.specific ? e.label : `a ${e.norm_key}`}, you described feeling ${top.value}.`,
        dream_ids: ids,
        strength: top.count,
        confidence: round(Math.min(0.9, 0.35 + 0.1 * top.count)),
        label: e.label,
        entity_type: e.entity_type,
      });
    }
  }

  // Recurring literal themes (water, flying, being late…)
  const byMotif = new Map();
  for (const m of index || []) for (const x of memoryMotifs(m)) byMotif.set(x, [...(byMotif.get(x) || []), m]);
  for (const [motif, ms] of byMotif) {
    if (ms.length < MIN_SUPPORT) continue;
    const recent = ms.filter((m) => now - new Date(m.dream_at).getTime() < 31 * 86400000).length;
    out.push({
      pattern_key: `theme:${motif}`,
      pattern_type: 'recurring_theme',
      description: `${cap(motif)} appeared in ${ms.length} of ${total} dreams${recent >= 2 && recent < ms.length ? ` (${recent} in the last month)` : ''}.`,
      dream_ids: ms.map((m) => m.dream_id),
      strength: ms.length,
      confidence: round(Math.min(0.9, 0.45 + 0.08 * ms.length)),
      label: motif,
    });
    const feelings = ms.flatMap((m) => (m.emotions || []).slice(0, 2));
    const top = mode(feelings);
    if (ms.length >= 3 && top && top.count / ms.length >= 0.6) {
      out.push({
        pattern_key: `theme_emotion:${motif}:${top.value}`,
        pattern_type: 'entity_emotion',
        description: `Dreams with ${motif} often came with feeling ${top.value} (${top.count} of ${ms.length}).`,
        dream_ids: ms.map((m) => m.dream_id),
        strength: top.count,
        confidence: round(Math.min(0.85, 0.3 + 0.1 * top.count)),
        label: motif,
      });
    }
  }

  // Most frequent recent feeling (last 30 days, needs at least 3 dreams)
  const recent = (index || []).filter((m) => now - new Date(m.dream_at).getTime() < 30 * 86400000);
  const topFeeling = mode(recent.flatMap((m) => (m.emotions || []).slice(0, 2)));
  if (recent.length >= 3 && topFeeling && topFeeling.count >= 2) {
    out.push({
      pattern_key: 'emotion_trend:recent',
      pattern_type: 'emotion_trend',
      description: `Your most frequent feeling in recent dreams: ${topFeeling.value} (${topFeeling.count} of ${recent.length}).`,
      dream_ids: recent.filter((m) => (m.emotions || []).includes(topFeeling.value)).map((m) => m.dream_id),
      strength: topFeeling.count,
      confidence: round(Math.min(0.85, 0.3 + 0.1 * topFeeling.count)),
      label: topFeeling.value,
    });
  }

  return out.sort((a, b) => b.strength - a.strength || b.confidence - a.confidence).slice(0, 40);
}

/**
 * How strongly two dreams are related, and why — the recurring-dream detector.
 * a, b: memories. occA, occB: [{entity_id, confidence}]. entities: Map id → {label, entity_type, specific}
 */
export function relateDreams(a, b, occA = [], occB = [], entities = new Map()) {
  let score = 0;
  const reasons = [];
  const inB = new Map(occB.map((o) => [o.entity_id, o]));
  for (const o of occA) {
    const other = inB.get(o.entity_id);
    const e = entities.get(o.entity_id);
    if (!other || !e) continue;
    const conf = Math.min(o.confidence, other.confidence);
    score += e.specific ? 2.5 * conf + 0.5 : 1.6 * conf;
    reasons.push({ kind: e.entity_type, label: e.label, sameness: conf >= 0.8 ? 'same' : 'similar' });
  }
  const motifsB = new Set(memoryMotifs(b));
  for (const x of memoryMotifs(a)) if (motifsB.has(x)) { score += 1; reasons.push({ kind: 'theme', label: x }); }
  const feelB = new Set(b.emotions || []);
  const shared = (a.emotions || []).filter((x) => feelB.has(x));
  if (shared.length) { score += 0.5 * shared.length; reasons.push({ kind: 'feeling', label: shared[0] }); }
  if (a.dream_type === 'recurring' || b.dream_type === 'recurring') score += 0.3;
  return { score: round(score), reasons: reasons.slice(0, 4) };
}

/** Plain words for a related-dream card. Water alone never makes two dreams "the same". */
export function relationLabel(link) {
  const r = link.reasons || [];
  const person = r.find((x) => x.kind === 'person');
  const place = r.find((x) => x.kind === 'place');
  const thing = r.find((x) => x.kind === 'object' || x.kind === 'creature');
  if (person) return `Also included ${person.label}`;
  if (place) return place.sameness === 'same' ? `Also set in ${place.label}` : `Another dream involving a ${place.label.replace(/^(a|an|the)\s+/i, '')}`;
  if (thing) return `${cap(thing.label.replace(/^(a|an|the)\s+/i, ''))} appeared here too`;
  const theme = r.find((x) => x.kind === 'theme');
  if (theme) return `${cap(theme.label)} appeared here too`;
  const feeling = r.find((x) => x.kind === 'feeling');
  if (feeling) return `Similar feeling: ${feeling.label}`;
  return 'Related dream';
}

/** "may be related" only when several things line up; never "identical". */
export function recurrenceWording(score) {
  if (score >= 4) return 'may be closely related to';
  if (score >= 2) return 'shares some elements with';
  return null;
}

export const LINK_THRESHOLD = 1.5;

function mode(values) {
  const counts = new Map();
  for (const v of values) if (v) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null;
  for (const [value, count] of counts) if (!best || count > best.count) best = { value, count };
  return best;
}
const cap = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
const round = (x) => Math.round(x * 100) / 100;
