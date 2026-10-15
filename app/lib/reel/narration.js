// Turns the dreamer's words into a short, faithful, cinematic narration —
// one line per scene — and picks the mood of the music.

export const MOODS = ['dreamy', 'mysterious', 'peaceful', 'cosmic', 'unsettling', 'nostalgic'];

// If the AI can't choose, the picture style decides.
const STYLE_MOOD = { dusk: 'nostalgic', neon: 'mysterious', retro: 'cosmic' };

export function fallbackMood(style) {
  return STYLE_MOOD[style] || 'dreamy';
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').replace(/[{}\\<>]/g, '').trim();
const words = (s) => clean(s).split(' ').filter(Boolean).length;

/** Checks the AI's answer; returns null if it isn't usable. */
export function validateNarration(parsed, sceneCount) {
  if (!parsed || !Array.isArray(parsed.lines)) return null;
  const lines = parsed.lines.map(clean).slice(0, sceneCount);
  if (lines.length !== sceneCount || lines.some((l) => !l || words(l) > 26)) return null;
  const total = lines.reduce((n, l) => n + words(l), 0);
  if (total < 15 || total > 95) return null;
  const mood = MOODS.includes(parsed.mood) ? parsed.mood : null;
  return { lines, mood };
}

/**
 * @returns {Promise<{lines: string[], mood: string, source: 'ai'|'captions'}>}
 * Never throws: if the AI fails, the scene captions become the narration.
 */
export async function writeNarration(openai, dream) {
  const scenes = dream.scenes || [];
  const fallback = {
    lines: scenes.map((s) => clean(s.caption)),
    mood: fallbackMood(dream.style),
    source: 'captions',
  };
  if (!openai || !scenes.length) return fallback;
  try {
    const completion = await openai.chat.completions.create({
      model: process.env.NARRATION_MODEL || 'gpt-4o-mini',
      temperature: 0.7,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You write the voice-over for a short vertical film of someone's dream. The film has exactly ${scenes.length} scenes, shown in order.
Return JSON: {"lines": string[${scenes.length}], "mood": one of ${JSON.stringify(MOODS)}}.
Rules for "lines" — one line per scene, matching that scene:
- First person, past tense, as the dreamer remembering it. Intimate, calm, cinematic, natural when spoken aloud.
- Faithful to the dream: keep its people, places and feelings. Never add new major events, never interpret or explain what it means.
- 8–16 words per line. All lines together: 45–75 words (about 20–25 seconds spoken).
- Plain words, no names of real people, no emojis, no quotation marks.
- The last line should land softly — often the moment of waking or the final image.
"mood" picks the background music: the dream's overall feeling.`,
        },
        {
          role: 'user',
          content: `The dream, in their words:\n"""${String(dream.transcript || '').slice(0, 3000)}"""\n\nThe scenes:\n${scenes
            .map((s, i) => `${i + 1}. ${clean(s.caption)}`)
            .join('\n')}`,
        },
      ],
    });
    const parsed = JSON.parse(completion.choices?.[0]?.message?.content || '{}');
    const ok = validateNarration(parsed, scenes.length);
    if (!ok) return fallback;
    return { lines: ok.lines, mood: ok.mood || fallback.mood, source: 'ai' };
  } catch (e) {
    console.error('narration writing failed', e?.message || e);
    return fallback;
  }
}
