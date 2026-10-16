// Reads each narration line aloud with OpenAI text-to-speech (already used by the app).
import { wavSeconds } from './render.js';

export const REEL_VOICE = process.env.NARRATOR_VOICE || 'marin';
export const REEL_VOICE_STYLE =
  'You are the person who had this dream, remembering it out loud the next morning. Speak plainly and quietly, as if telling a friend over coffee — natural, a little unsure in places, conversational pacing. Not a narrator, not a storyteller voice, not dramatic, not whispery. Clearly intelligible.';

/** @returns {Promise<{wav: Buffer, seconds: number}|null>} null when speech isn't available */
export async function speakLine(openai, text) {
  if (!openai || !text) return null;
  try {
    const res = await openai.audio.speech.create({
      model: 'gpt-4o-mini-tts',
      voice: REEL_VOICE,
      input: text.slice(0, 600),
      instructions: REEL_VOICE_STYLE,
      response_format: 'wav',
    });
    const wav = Buffer.from(await res.arrayBuffer());
    const seconds = wavSeconds(wav);
    if (!seconds || seconds < 0.4 || seconds > 20) return null;
    return { wav, seconds };
  } catch (e) {
    console.error('narration voice failed', e?.message || e);
    return null;
  }
}
