// Checks around each Guru reply. Pure (tested in test/guru-v2.test.mjs).
import { EXPRESSIONS } from '../guru-expression.js';

export const MAX_CLARIFICATIONS = 2;

/** Phrases that claim knowledge of earlier dreams. */
const PAST = /\b(again|as before|like before|you('ve| have) (mentioned|dreamt|dreamed|had|told me)|your (earlier|previous|last|other) dream|in (one of )?your (earlier|previous|past) dreams|i remember (your|when you|that you)|last time you|once more|recurring)\b/i;

export function mentionsPastDreams(text) {
  return PAST.test(String(text || '').replace(/[’‘]/g, "'"));
}

/**
 * Parses the model's JSON reply and enforces the rules we can check:
 * - cited dreams must be ones we actually gave it (refs), anything else is dropped;
 * - with no history at all, a reply that claims a past is flagged for a retry.
 */
export function checkReply(raw, { refs = new Map(), firstDream = false, userSaidAgain = false } = {}) {
  let j = {};
  try { j = JSON.parse(raw || '{}'); } catch { j = { text: String(raw || '') }; }
  const text = typeof j.text === 'string' ? j.text.trim() : '';
  const cited = [...new Set((Array.isArray(j.cited_dream_ids) ? j.cited_dream_ids : []).map(String))]
    .map((r) => refs.get(r.replace(/[[\]]/g, '')))
    .filter(Boolean);
  // "again" is fine when the dreamer said it ("I dreamed about my brother again").
  const fabricatedPast = firstDream && !userSaidAgain && mentionsPastDreams(text);
  return {
    text,
    expression: EXPRESSIONS.includes(j.expression) ? j.expression : null,
    askedQuestion: j.asked_question === true || /\?\s*$/.test(text),
    dreamComplete: j.dream_complete === true,
    offerVisualize: j.offer_visualize === true,
    cited,
    ok: Boolean(text) && !fabricatedPast,
    fabricatedPast,
  };
}

/** How many more follow-up questions Orin may ask about the dream being captured. */
export function questionsLeft(conversation) {
  return Math.max(0, MAX_CLARIFICATIONS - (conversation?.clarifications || 0));
}

/**
 * May Orin offer to visualize this dream now? Not after every dream: only a saved,
 * vivid-enough dream, with no reel yet, for someone who can make one, once per conversation.
 */
export function mayOfferVisualize({ dream, memory, hasProduction, canGenerateReel, offeredAlready, userTurns }) {
  if (!dream || hasProduction || !canGenerateReel || offeredAlready) return false;
  if ((dream.scenes || []).length) return false;          // already has pictures
  if ((userTurns || 0) < 2) return false;                 // they're engaged, not a one-liner
  const words = String(dream.transcript || '').split(/\s+/).filter(Boolean).length;
  if (words < 35) return false;
  if (memory) {
    const visual = (memory.places?.length || 0) + (memory.objects?.length || 0) + (memory.creatures?.length || 0) + (memory.people?.length || 0);
    if (visual < 2 || memory.dream_type === 'fragment') return false;
  }
  return true;
}
