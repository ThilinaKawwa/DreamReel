// What kind of turn is this? Cheap rules, no AI call. Pure (tested in test/guru-v2.test.mjs).
// The intent picks which instructions Orin gets and which memories are fetched.
export const INTENTS = [
  'dream_capture', 'clarification', 'reflection', 'recall', 'search', 'pattern_question',
  'entity_question', 'general_dream_discussion', 'visualization_request',
];

const VISUALIZE = /\b(visuali[sz]e|animate|make (it|this|that)( dream)? into|turn (it|this|that)( dream)? into|make (me )?a (reel|video|film|movie)|create a (reel|video|film)|(dream ?)?reel of (it|this|that))\b/i;
const SEARCH = /^(please\s+)?(show|find|list|search|give)( me)?\b.*\bdreams?\b|\b(which|what) (of my )?dreams\b/i;
const PATTERN = /\b(why do i keep|i keep dreaming|keep having|recurring|pattern|patterns|how often|how many (dreams|times)|what themes|most common|always dream|so often|themes? (appeared|this month|this week))\b/i;
const RECALL = /\b(have i (ever )?(dreamt|dreamed|had a dream)|did i (ever )?(dream|have a dream)|when did i (last )?(dream|have)|last time i (dreamt|dreamed)|(dreamt|dreamed) (about|of) (this|that|it|him|her|them) before|been (here|there) before|remember (my|the|when|that)|that dream (about|where|with)|my (earlier|last|previous) dream)\b/i;
const REFLECT = /\b(what (does|do|could|might) (it|this|that|these|the \w+) mean|meaning of|why (did|would) i dream|what do you (think|make of)|interpret|significance)\b/i;
const NARRATIVE = /\b(i dreamt|i dreamed|i had (a|this) dream|last night|in my dream|in the dream|i was|i saw|there was|there were|we were|i remember|then (i|he|she|we|they)|suddenly)\b/i;

/** The dreamer is starting a second, different dream in the same conversation. */
export const NEW_DREAM = /\b(another|a different|a second|the other) dream\b|\bi also (dreamt|dreamed|had a dream)\b|\bthen i had (a|another) dream\b/i;

const isQuestion = (t) => /\?\s*$/.test(t) || /^(who|what|when|where|why|how|do|does|did|is|are|was|were|have|has|can|could|should|would|will)\b/i.test(t);

/**
 * @param {string} text  what the dreamer just said
 * @param {object} state
 * @param {boolean} state.capturing        a dream is being told in this conversation
 * @param {boolean} state.orinAsked        Orin's last message ended with a question
 * @param {boolean} state.hasDream         this conversation already holds a dream
 * @param {boolean} state.mentionsEntity   the text names a known recurring person/place/thing
 */
export function classifyIntent(text, state = {}) {
  const t = String(text || '').trim();
  if (!t) return 'general_dream_discussion';
  if (VISUALIZE.test(t)) return 'visualization_request';
  if (NEW_DREAM.test(t) && !isQuestion(t)) return 'dream_capture';
  if (SEARCH.test(t)) return 'search';
  if (PATTERN.test(t)) return 'pattern_question';
  if (RECALL.test(t)) return 'recall';
  const question = isQuestion(t);
  if (state.capturing && state.orinAsked && !question) return 'clarification';
  if (REFLECT.test(t) && (state.hasDream || state.capturing)) return 'reflection';
  if (question && state.mentionsEntity) return 'entity_question';
  if (!question && (NARRATIVE.test(t) || (!state.hasDream && t.split(/\s+/).length >= 6))) return 'dream_capture';
  if (state.capturing && !question) return 'dream_capture';
  if (REFLECT.test(t)) return 'reflection';
  return 'general_dream_discussion';
}

/** Turns that add the dreamer's words to the dream being captured. */
export const CAPTURE_INTENTS = new Set(['dream_capture', 'clarification']);
/** Turns answered from the archive (all matches, not just a few relevant ones). */
export const ARCHIVE_INTENTS = new Set(['search', 'recall', 'pattern_question', 'entity_question']);
