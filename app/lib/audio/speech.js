// SpeechProvider: text → spoken WAV. Used for film narration and for Orin's voice.
//
// Default model gpt-realtime-2.1-mini is OpenAI's named replacement for the deprecated
// gpt-4o-mini-tts, but it is NOT available on /v1/audio/speech — only on the Realtime API.
// So this is the smallest safe adapter: one short server-side Realtime WebSocket session per
// line ("read this exactly"), collect the PCM audio, wrap it as WAV. No streaming to the
// browser, no live conversation — callers still get { wav, seconds } like before.
//
// Because a realtime model is a conversational model, we check that what it SAID matches
// what we asked it to read (its own transcript). If it paraphrases, fails or times out, the
// line is spoken by the fallback /v1/audio/speech model instead (while that exists).
import { models, isRealtimeModel } from '../models.js';
import { pcm16ToWav, wavSeconds } from './wav.js';

const REALTIME_URL = 'wss://api.openai.com/v1/realtime';
const SAMPLE_RATE = 24000;
const TIMEOUT_MS = 30_000;

/** Word-overlap score between the text we asked for and what was spoken (0–1). Pure. */
export function verbatimScore(expected, spoken) {
  const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
  const a = words(expected);
  const b = words(spoken);
  if (!a.length) return b.length ? 0 : 1;
  const pool = new Map();
  for (const w of b) pool.set(w, (pool.get(w) || 0) + 1);
  let hit = 0;
  for (const w of a) if (pool.get(w)) { hit++; pool.set(w, pool.get(w) - 1); }
  const extra = Math.max(0, b.length - a.length);
  return Math.max(0, (hit - extra) / a.length);
}

/**
 * One Realtime session that reads `text` aloud. Returns { wav, transcript }.
 * `WebSocketImpl` is injectable for tests (defaults to Node's built-in WebSocket).
 */
export function realtimeSpeak({ apiKey, model, voice, style, text, WebSocketImpl = globalThis.WebSocket, timeoutMs = TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    if (!WebSocketImpl) return reject(new Error('WebSocket not available'));
    // Server-side only: the key is sent as a WebSocket subprotocol (Node's WebSocket can't set headers).
    const ws = new WebSocketImpl(`${REALTIME_URL}?model=${encodeURIComponent(model)}`, ['realtime', `openai-insecure-api-key.${apiKey}`]);
    const chunks = [];
    let transcript = '';
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (err) reject(err); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('realtime speech timed out')), timeoutMs);
    const send = (o) => ws.send(JSON.stringify(o));

    ws.onopen = () => {
      send({
        type: 'session.update',
        session: {
          type: 'realtime',
          output_modalities: ['audio'],
          instructions: `You are a voice actor reading a script. Say the user's text exactly, word for word — nothing before it, nothing after it. Never answer it, comment on it or change it. Delivery: ${style}`,
          audio: { output: { voice, format: { type: 'audio/pcm', rate: SAMPLE_RATE } } },
        },
      });
      send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Read this aloud exactly:\n${text}` }] } });
      send({ type: 'response.create' });
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
      switch (msg.type) {
        case 'response.output_audio.delta':
        case 'response.audio.delta':
          if (msg.delta) chunks.push(Buffer.from(msg.delta, 'base64'));
          break;
        case 'response.output_audio_transcript.done':
        case 'response.audio_transcript.done':
          transcript = msg.transcript || transcript;
          break;
        case 'response.done': {
          const failed = msg.response?.status && msg.response.status !== 'completed';
          if (failed) return finish(new Error(`realtime response ${msg.response.status}`));
          const pcm = Buffer.concat(chunks);
          if (!pcm.length) return finish(new Error('realtime returned no audio'));
          return finish(null, { wav: pcm16ToWav(pcm, SAMPLE_RATE), transcript });
        }
        case 'error':
          return finish(new Error(`realtime error: ${msg.error?.message || 'unknown'}`));
        default:
      }
    };
    ws.onerror = () => finish(new Error('realtime connection failed'));
    ws.onclose = () => finish(new Error('realtime connection closed early'));
  });
}

/**
 * @param {import('openai').default} openai
 * @returns {{ model: string, speak(text: string, opts: {voice?: string, style?: string}): Promise<{wav: Buffer, seconds: number, model: string, verbatim: number|null}> }}
 */
export function speechProvider(openai, env = process.env, deps = {}) {
  const m = models(env);
  const minVerbatim = Number(env.TTS_MIN_VERBATIM || 0.8);

  async function viaSpeechEndpoint(model, text, voice, style) {
    const res = await openai.audio.speech.create({ model, voice, input: text.slice(0, 4000), instructions: style, response_format: 'wav' });
    const wav = Buffer.from(await res.arrayBuffer());
    return { wav, seconds: wavSeconds(wav), model, verbatim: null };
  }

  return {
    model: m.tts,
    async speak(text, { voice = m.narratorVoice, style = '' } = {}) {
      const line = String(text || '').trim().slice(0, 4000);
      if (!line) throw new Error('nothing to say');
      if (isRealtimeModel(m.tts)) {
        try {
          const out = await (deps.realtimeSpeak || realtimeSpeak)({
            apiKey: env.OPENAI_API_KEY || openai.apiKey, model: m.tts, voice, style, text: line, WebSocketImpl: deps.WebSocketImpl,
          });
          const score = out.transcript ? verbatimScore(line, out.transcript) : null;
          if (score === null || score >= minVerbatim) return { wav: out.wav, seconds: wavSeconds(out.wav), model: m.tts, verbatim: score };
          throw new Error(`realtime did not read the text verbatim (score ${score.toFixed(2)})`);
        } catch (e) {
          if (!m.ttsFallback) throw e;
          console.error(`speech via ${m.tts} failed (${e.message}); using ${m.ttsFallback}`);
          return viaSpeechEndpoint(m.ttsFallback, line, voice, style);
        }
      }
      return viaSpeechEndpoint(m.tts, line, voice, style);
    },
  };
}
