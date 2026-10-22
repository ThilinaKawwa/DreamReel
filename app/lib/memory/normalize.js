// DREAM MEMORY — level 1: one structured record per dream. Pure (tested in test/memory.test.mjs).
// The model reads the dreamer's own words (plus any follow-up answers) and records what is
// in the dream. It does not interpret. The original words always stay in dreams.transcript.
import { createHash } from 'node:crypto';

export const MEMORY_VERSION = 'dream-memory-v1';
export const DREAM_TYPES = ['fragment', 'story', 'nightmare', 'lucid', 'recurring', 'other'];

export const MEMORY_SYSTEM = `You record dreams for a private dream journal. Someone told their dream out loud, messily: pauses, repetition, corrections ("my brother — actually I think he came later"), slang, uncertainty.
Record what is IN the dream, faithfully. Do not interpret, do not add symbolism, do not make it more exciting.

Rules:
- Never invent people, places, objects, events or feelings. Only what they said or clearly implied.
- Keep their corrections (the later version wins) and their uncertainty ("a house like my grandmother's, but not exactly").
- Use their own words for labels where possible ("my brother", "a silver door", "the old station").
- Feelings: only ones they said or clearly showed. Lowercase single words or short phrases.
- Themes: 0–4 plain, literal motifs (e.g. "water", "flying", "being late", "being chased", "searching", "falling"). Not interpretations like "transition" or "fear of change".
- If "Follow-up answers" are given, they are the dreamer's own clarifications — include them.
- If a DreamBible is given, it was extracted earlier from the same words; use it only to check yourself.

Return JSON only:
{
  "title": string,             // 2–5 plain, evocative words, no full stop
  "summary": string,           // one sentence, max 25 words, second person ("You were walking through a forest…")
  "cleaned_text": string,      // the dream told clearly, first person, past tense, in their plain words (max 200 words)
  "dream_type": one of ${JSON.stringify(DREAM_TYPES)},  // "fragment" if they only remember a little
  "emotions": string[],        // 0–4
  "themes": string[],          // 0–4
  "people": [{"label": string, "relation": string|null, "description": string|null, "emotion": string|null}],
  "places": [{"label": string, "description": string|null, "familiar": boolean}],  // familiar = they knew or recognised it
  "objects": [{"label": string, "description": string|null}],
  "creatures": [{"label": string, "description": string|null}],
  "events": string[],          // 1–6 short steps in order
  "details": string[]          // 0–4 short phrases they used that seem to matter to them
}`;

const str = (v, max = 300) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const strOrNull = (v, max) => str(v, max) || null;
const list = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
const words = (v, n, max = 40) => [...new Set(list(v, n * 2).map((x) => str(x, max).toLowerCase()).filter(Boolean))].slice(0, n);

/** Validates the model's answer. Throws if unusable. The original transcript is never edited here. */
export function normalizeMemory(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('memory: not an object');
  const items = (v, n, extra) => list(v, n).map((x) => {
    const label = str(typeof x === 'string' ? x : x?.label, 80);
    if (!label) return null;
    return { label, description: strOrNull(x?.description, 200), ...extra(x || {}) };
  }).filter(Boolean);
  const memory = {
    title: str(raw.title, 60) || 'A remembered dream',
    summary: str(raw.summary, 220),
    cleaned_text: str(raw.cleaned_text, 1600),
    dream_type: DREAM_TYPES.includes(raw.dream_type) ? raw.dream_type : 'story',
    emotions: words(raw.emotions, 4, 30),
    themes: words(raw.themes, 4, 30),
    people: items(raw.people, 8, (x) => ({ relation: strOrNull(x.relation, 60), emotion: strOrNull(x.emotion, 30) })),
    places: items(raw.places, 6, (x) => ({ familiar: x.familiar === true })),
    objects: items(raw.objects, 8, () => ({})),
    creatures: items(raw.creatures, 6, () => ({})),
    events: list(raw.events, 6).map((e) => str(e, 160)).filter(Boolean),
    details: list(raw.details, 4).map((e) => str(e, 120)).filter(Boolean),
  };
  if (!memory.summary && !memory.cleaned_text) throw new Error('memory: empty');
  memory.title = memory.title.replace(/[.。]+$/, '');
  return memory;
}

/**
 * Adapter: what the Dream Director already understood (a DreamBible) as memory hints,
 * so a visualized dream's extraction can be checked against it rather than re-invented.
 */
export function bibleHints(bible) {
  if (!bible || typeof bible !== 'object') return null;
  return {
    cleaned: str(bible.cleanedDream, 1200),
    feelings: list(bible.emotionalArc, 5),
    people: list(bible.characters, 6).map((c) => str(`${c.role || ''}${c.relationship ? ` (${c.relationship})` : ''}`, 80)),
    places: list(bible.locations, 5).map((l) => str(l.name, 60)),
    objects: list(bible.objects, 6).map((o) => str(o.name, 60)),
  };
}

/** What the extraction model reads. */
export function memoryInput({ transcript, followUps = [], bible = null }) {
  const parts = [`The dreamer said (transcribed speech, untouched):\n"""${String(transcript || '').slice(0, 8000)}"""`];
  const answers = followUps.filter((f) => f?.answer);
  if (answers.length) parts.push(`Follow-up answers:\n${answers.map((f) => `- Q: ${str(f.question, 200)}\n  A: ${str(f.answer, 400)}`).join('\n')}`);
  const hints = bibleHints(bible);
  if (hints) parts.push(`DreamBible (earlier extraction of the same words):\n${JSON.stringify(hints)}`);
  return parts.join('\n\n');
}

/** Fingerprint of what a memory was built from; a mismatch means it must be rebuilt. */
export function sourceHash(transcript, followUps = []) {
  return createHash('sha256')
    .update(MEMORY_VERSION).update('\n')
    .update(String(transcript || '')).update('\n')
    .update(JSON.stringify(followUps.map((f) => [f.question || '', f.answer || ''])))
    .digest('hex').slice(0, 32);
}

/**
 * Pairs Orin's questions with the dreamer's next answer during capture.
 * messages: [{role, content, intent}] in time order.
 */
export function followUpsFrom(messages) {
  const out = [];
  for (let i = 0; i < messages.length - 1; i++) {
    const m = messages[i];
    const next = messages[i + 1];
    if (m.role === 'assistant' && /\?\s*$/.test(m.content.trim()) && next.role === 'user') {
      const q = m.content.trim().split(/(?<=[.!])\s+/).pop();
      out.push({ question: str(q, 240), answer: str(next.content, 600) });
    }
  }
  return out.slice(-4);
}
