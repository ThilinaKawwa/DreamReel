// Reads each narration line aloud through the SpeechProvider (lib/audio/speech.js).
import { speechProvider } from '../audio/speech.js';
import { models } from '../models.js';

export const REEL_VOICE = models().narratorVoice;
export const REEL_VOICE_STYLE =
  'You are the person who had this dream, remembering it out loud the next morning. Speak plainly and quietly, as if telling a friend over coffee — natural, a little unsure in places, conversational pacing. Not a narrator, not a storyteller voice, not dramatic, not whispery. Clearly intelligible.';

/** @returns {Promise<{wav: Buffer, seconds: number, model: string}|null>} null when speech isn't available */
export async function speakLine(openai, text) {
  if (!openai || !text) return null;
  try {
    const out = await speechProvider(openai).speak(text.slice(0, 600), { voice: REEL_VOICE, style: REEL_VOICE_STYLE });
    if (!out.seconds || out.seconds < 0.4 || out.seconds > 20) return null;
    return { wav: out.wav, seconds: out.seconds, model: out.model, provider: out.provider, transport: out.transport, fallbackUsed: out.fallbackUsed };
  } catch (e) {
    console.error('narration voice failed', e?.message || e);
    return null;
  }
}
