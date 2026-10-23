// SpeechProvider: text → spoken WAV. Used for film narration and for Orin's voice.
//
// Preferred path: the ordinary /v1/audio/speech endpoint with TTS_MODEL (default
// gpt-realtime-2.1-mini, OpenAI's named replacement for the deprecated gpt-4o-mini-tts).
// Narration lines and Guru replies are short, bounded texts — no live session is needed.
//
// Contingency path, used ONLY if OpenAI rejects the model on /v1/audio/speech: a minimal
// server-side Realtime WebSocket session per line ("read this exactly"), PCM → WAV, with a
// check that the spoken words match the text. Which path ran is returned with every result
// (transport, fallbackUsed) and recorded by the callers, so reliability can be measured.
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

// A model the speech endpoint has rejected (per server process), so we don't retry a known failure.
const speechEndpointRejects = new Set();

/** True when an API error means "this model can't be used on this endpoint" (not a content/audio problem). */
export function isModelUnsupported(e) {
  const m = String(e?.message || e?.error?.message || '');
  return (e?.status === 400 || e?.status === 404 || e?.status === 403)
    && /model|endpoint/i.test(m) && /not (supported|found|exist|available|allowed)|does not (exist|support)|unsupported|invalid model|do not have access/i.test(m);
}

/**
 * SpeechProvider. Order of attempts for TTS_MODEL:
 *   1. /v1/audio/speech            — the simple path (preferred whenever OpenAI accepts the model)
 *   2. Realtime adapter            — only if (1) rejects the model AND the model is a realtime model
 *   3. TTS_FALLBACK_MODEL on (1)   — temporary emergency fallback; every use is recorded
 * TTS_TRANSPORT=speech|realtime forces one transport (default: auto = the order above).
 * @returns {{ model: string, speak(text, opts): Promise<{wav, seconds, model, provider, transport, fallbackUsed, verbatim}> }}
 */
export function speechProvider(openai, env = process.env, deps = {}) {
  const m = models(env);
  const transport = env.TTS_TRANSPORT || 'auto';
  const minVerbatim = Number(env.TTS_MIN_VERBATIM || 0.8);

  async function viaSpeechEndpoint(model, text, voice, style) {
    const res = await openai.audio.speech.create({ model, voice, input: text.slice(0, 4000), instructions: style, response_format: 'wav' });
    const wav = Buffer.from(await res.arrayBuffer());
    const seconds = wavSeconds(wav);
    if (!seconds) throw new Error('speech endpoint returned no usable audio');
    return { wav, seconds, model, provider: 'openai', transport: 'speech', verbatim: null };
  }

  async function viaRealtime(text, voice, style) {
    const out = await (deps.realtimeSpeak || realtimeSpeak)({
      apiKey: env.OPENAI_API_KEY || openai.apiKey, model: m.tts, voice, style, text, WebSocketImpl: deps.WebSocketImpl,
    });
    const score = out.transcript ? verbatimScore(text, out.transcript) : null;
    if (score !== null && score < minVerbatim) throw new Error(`realtime did not read the text verbatim (score ${score.toFixed(2)})`);
    return { wav: out.wav, seconds: wavSeconds(out.wav), model: m.tts, provider: 'openai', transport: 'realtime', verbatim: score };
  }

  async function primary(line, voice, style) {
    const tryRealtime = transport === 'realtime' || (transport === 'auto' && isRealtimeModel(m.tts));
    if (transport !== 'realtime' && !speechEndpointRejects.has(m.tts)) {
      try {
        return await viaSpeechEndpoint(m.tts, line, voice, style);
      } catch (e) {
        if (!(tryRealtime && isModelUnsupported(e))) throw e;
        speechEndpointRejects.add(m.tts);
        console.warn(`/v1/audio/speech rejected ${m.tts} (${e.message}); using the Realtime adapter`);
      }
    }
    if (tryRealtime) return viaRealtime(line, voice, style);
    throw new Error(`${m.tts} is not usable on /v1/audio/speech`);
  }

  return {
    model: m.tts,
    async speak(text, { voice = m.narratorVoice, style = '' } = {}) {
      const line = String(text || '').trim().slice(0, 4000);
      if (!line) throw new Error('nothing to say');
      try {
        return { ...(await primary(line, voice, style)), fallbackUsed: false };
      } catch (e) {
        if (!m.ttsFallback) throw e;
        console.error(`TTS fallback used: ${m.tts} failed (${e.message}); speaking with ${m.ttsFallback}`);
        return { ...(await viaSpeechEndpoint(m.ttsFallback, line, voice, style)), fallbackUsed: true, primaryError: String(e.message).slice(0, 160) };
      }
    },
  };
}

/** Test hook: forget remembered endpoint rejections. */
export function _resetSpeechMemo() { speechEndpointRejects.clear(); }
