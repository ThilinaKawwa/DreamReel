// TranscriptionProvider: speech → text. One place for the model choice and its fallback.
import { models } from '../models.js';

/**
 * @param {import('openai').default} openai
 * @returns {{ model: string, transcribe(file: File|Blob, opts?: {prompt?: string}): Promise<{text: string, model: string}> }}
 */
export function transcriptionProvider(openai, env = process.env) {
  const m = models(env);
  async function run(model, file, prompt) {
    const r = await openai.audio.transcriptions.create({ file, model, ...(prompt ? { prompt } : {}) });
    return { text: String(r?.text || '').trim(), model };
  }
  return {
    model: m.transcription,
    async transcribe(file, { prompt } = {}) {
      try {
        return await run(m.transcription, file, prompt);
      } catch (e) {
        // Only a model-availability problem falls back; bad audio is reported as bad audio.
        const unavailable = e?.status === 404 || /model/i.test(String(e?.message || '')) && /not (found|exist|available|supported)|does not have access|deprecated|removed/i.test(String(e?.message || ''));
        if (!m.transcriptionFallback || !unavailable) throw e;
        console.error(`transcription model ${m.transcription} unavailable, using ${m.transcriptionFallback}`);
        return run(m.transcriptionFallback, file, prompt);
      }
    },
  };
}
