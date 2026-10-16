// Final pre-real-test checks: Kling O1 request schema, TranscriptionProvider, SpeechProvider
// (Realtime adapter with a fake WebSocket — no paid API calls), model config, cost lines.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VIDEO_ADAPTERS, videoProvider, o1Input, O1_MAX_INPUTS } from '../lib/providers/index.js';
import { normalizeBible } from '../lib/director/bible.js';
import { normalizeStoryboard } from '../lib/director/storyboard.js';
import { videoRequest } from '../lib/director/compiler.js';
import { routeShot } from '../lib/director/routing.js';
import { transcriptionProvider } from '../lib/audio/transcription.js';
import { speechProvider, realtimeSpeak, verbatimScore } from '../lib/audio/speech.js';
import { pcm16ToWav, wavSeconds } from '../lib/audio/wav.js';
import { models, isRealtimeModel } from '../lib/models.js';
import { estimateReel, usageLine, units } from '../lib/cinema/costs.js';

// ---- Kling O1 schema -------------------------------------------------------------------
const bible = normalizeBible({
  locations: [{ id: 'forest_01', name: 'dark forest' }, { id: 'sea_01', name: 'sea' }],
  characters: [{ id: 'brother_01', role: "the dreamer's brother", clothing: 'red zip-up jacket' }],
  objects: [{ id: 'silver_key_01', name: 'silver key', description: 'old ornate silver key' }],
  chronology: [{ event: 'walk' }, { event: 'door' }],
}, 'test');
const board = normalizeStoryboard({ shots: [
  { locationId: 'forest_01', characterIds: ['brother_01'], objectIds: ['silver_key_01'], visual: 'brother holds the key', action: 'brother lifts the key' },
  { locationId: 'sea_01', characterIds: ['brother_01'], objectIds: ['silver_key_01'], visual: 'key in the door', action: 'the door swings open' },
] }, bible, { maxShots: 5 });

test('O1: one recurring character + one recurring object + start frame, 9:16, 5 s', () => {
  const shot = board.shots[0];
  const route = routeShot(board, shot, {});
  assert.equal(route.mode, 'identity');
  assert.equal(route.provider, 'kling-o1-ref');
  assert.deepEqual(route.identityKeys, ['character:brother_01', 'object:silver_key_01']);
  const vr = videoRequest(bible, shot);
  const req = {
    startImageUrl: 'https://x.supabase.co/kf.jpg', prompt: vr.prompt, duration: vr.duration,
    elements: [
      { label: vr.labels['character:brother_01'], frontal: 'https://x/front.jpg', references: ['https://x/tq.jpg'] },
      { label: vr.labels['object:silver_key_01'], frontal: 'https://x/key.jpg', references: [] },
    ],
  };
  const body = VIDEO_ADAPTERS['kling-o1-ref'].input(req);
  assert.deepEqual(Object.keys(body).sort(), ['aspect_ratio', 'duration', 'elements', 'image_urls', 'prompt']);
  assert.deepEqual(body.image_urls, ['https://x.supabase.co/kf.jpg']);
  assert.deepEqual(body.elements, [
    { frontal_image_url: 'https://x/front.jpg', reference_image_urls: ['https://x/tq.jpg'] },
    { frontal_image_url: 'https://x/key.jpg', reference_image_urls: [] },
  ]);
  assert.equal(body.duration, '5');
  assert.equal(body.aspect_ratio, '9:16');
  assert.match(body.prompt, /^@Image1 is the opening frame/);
  assert.match(body.prompt, /@Element1 is the dreamer's brother \(red zip-up jacket\)/);
  assert.match(body.prompt, /@Element2 is silver key/);
  assert.equal(videoProvider('kling-o1-ref').model, 'fal-ai/kling-video/o1/reference-to-video');
  assert.equal(videoProvider('kling-o1-ref').costPerSecond, 0.112);
});

test('O1: never more than 7 inputs (start frame + frontals + references)', () => {
  const many = Array.from({ length: 4 }, (_, i) => ({ label: `p${i}`, frontal: `f${i}`, references: [`a${i}`, `b${i}`, `c${i}`] }));
  const body = o1Input({ startImageUrl: 's', prompt: 'x', duration: 5, elements: many });
  const total = body.image_urls.length + body.elements.reduce((n, e) => n + 1 + e.reference_image_urls.length, 0);
  assert.ok(total <= O1_MAX_INPUTS, `total ${total}`);
  assert.ok(body.elements.length >= 3, 'reference angles are dropped before whole elements');
  assert.equal(body.elements.filter((e) => e.frontal_image_url).length, body.elements.length);
});

test('scenic shots use Kling 2.5 first-frame image-to-video', () => {
  const body = VIDEO_ADAPTERS['kling-i2v'].input({ startImageUrl: 's', prompt: 'water rises', negative: 'text', duration: 5 });
  assert.deepEqual(body, { prompt: 'water rises', image_url: 's', duration: '5', negative_prompt: 'text', cfg_scale: 0.5 });
  assert.equal(videoProvider('kling-i2v').costPerSecond, 0.07);
});

// ---- Model config ----------------------------------------------------------------------
test('models are central, current and overridable', () => {
  const m = models({});
  assert.equal(m.transcription, 'gpt-transcribe');
  assert.equal(m.tts, 'gpt-realtime-2.1-mini');
  assert.equal(m.transcriptionFallback, '');
  assert.equal(m.guruVoice, 'cedar');
  assert.equal(m.director, 'gpt-4.1');
  assert.equal(models({ VIDEO_PROVIDER: 'kling-o1-ref' }).scenicVideo, 'kling-o1-ref', 'older name still honoured');
  assert.equal(models({ TTS_MODEL: 'gpt-4o-mini-tts' }).tts, 'gpt-4o-mini-tts');
  assert.ok(isRealtimeModel('gpt-realtime-2.1-mini'));
  assert.ok(!isRealtimeModel('gpt-4o-mini-tts'));
});

// ---- TranscriptionProvider ----------------------------------------------------------------
function fakeOpenAI({ transcribe, speech } = {}) {
  const calls = { transcribe: [], speech: [] };
  return {
    calls,
    apiKey: 'sk-test',
    audio: {
      transcriptions: { create: async (args) => { calls.transcribe.push(args); return transcribe(args); } },
      speech: { create: async (args) => { calls.speech.push(args); return speech(args); } },
    },
  };
}

test('transcription uses gpt-transcribe with the dream prompt', async () => {
  const ai = fakeOpenAI({ transcribe: async () => ({ text: '  I was in a station.  ' }) });
  const out = await transcriptionProvider(ai, {}).transcribe('FILE', { prompt: 'A dream' });
  assert.deepEqual(out, { text: 'I was in a station.', model: 'gpt-transcribe' });
  assert.equal(ai.calls.transcribe[0].model, 'gpt-transcribe');
  assert.equal(ai.calls.transcribe[0].prompt, 'A dream');
  assert.equal(ai.calls.transcribe[0].file, 'FILE');
});

test('transcription: unclear audio is an error, not a silent model switch; fallback only if configured', async () => {
  const bad = fakeOpenAI({ transcribe: async () => { throw Object.assign(new Error('Audio file might be corrupted'), { status: 400 }); } });
  await assert.rejects(transcriptionProvider(bad, { TRANSCRIPTION_FALLBACK_MODEL: 'whisper-1' }).transcribe('F'));
  assert.equal(bad.calls.transcribe.length, 1);
  let n = 0;
  const gone = fakeOpenAI({ transcribe: async (a) => { if (n++ === 0) throw Object.assign(new Error('The model `gpt-transcribe` does not exist'), { status: 404 }); return { text: 'ok' }; } });
  const out = await transcriptionProvider(gone, { TRANSCRIPTION_FALLBACK_MODEL: 'whisper-1' }).transcribe('F');
  assert.equal(out.model, 'whisper-1');
  const none = fakeOpenAI({ transcribe: async () => { throw Object.assign(new Error('model not found'), { status: 404 }); } });
  await assert.rejects(transcriptionProvider(none, {}).transcribe('F'), 'no fallback by default');
});

// ---- SpeechProvider (Realtime adapter, fake socket) -------------------------------------------
function fakeSocket(script) {
  return class FakeWS {
    constructor(url, protocols) {
      this.url = url; this.protocols = protocols; this.sent = [];
      FakeWS.last = this;
      setTimeout(() => this.onopen?.(), 0);
    }
    send(s) {
      const m = JSON.parse(s);
      this.sent.push(m);
      if (m.type === 'response.create') setTimeout(() => script(this), 0);
    }
    emit(o) { this.onmessage?.({ data: JSON.stringify(o) }); }
    close() { this.closed = true; }
  };
}
const PCM_1S = Buffer.alloc(24000 * 2, 1); // one second of 24 kHz 16-bit mono

test('realtime adapter: correct session, verbatim request, PCM collected into a WAV', async () => {
  const WS = fakeSocket((ws) => {
    ws.emit({ type: 'response.output_audio.delta', delta: PCM_1S.subarray(0, 24000).toString('base64') });
    ws.emit({ type: 'response.output_audio.delta', delta: PCM_1S.subarray(24000).toString('base64') });
    ws.emit({ type: 'response.output_audio_transcript.done', transcript: 'I was standing by the sea.' });
    ws.emit({ type: 'response.done', response: { status: 'completed' } });
  });
  const out = await realtimeSpeak({ apiKey: 'sk-test', model: 'gpt-realtime-2.1-mini', voice: 'cedar', style: 'calm', text: 'I was standing by the sea.', WebSocketImpl: WS });
  const ws = WS.last;
  assert.equal(ws.url, 'wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1-mini');
  assert.deepEqual(ws.protocols, ['realtime', 'openai-insecure-api-key.sk-test']);
  const [session, item, create] = ws.sent;
  assert.equal(session.type, 'session.update');
  assert.deepEqual(session.session.output_modalities, ['audio']);
  assert.equal(session.session.audio.output.voice, 'cedar');
  assert.deepEqual(session.session.audio.output.format, { type: 'audio/pcm', rate: 24000 });
  assert.equal(item.item.content[0].type, 'input_text');
  assert.match(item.item.content[0].text, /I was standing by the sea\./);
  assert.equal(create.type, 'response.create');
  assert.equal(Math.round(wavSeconds(out.wav) * 100) / 100, 1, 'duration measured from the WAV');
  assert.equal(out.transcript, 'I was standing by the sea.');
  assert.ok(ws.closed);
});

test('speech provider: realtime success keeps Orin\'s voice and reports duration + model', async () => {
  const ai = fakeOpenAI();
  const out = await speechProvider(ai, { OPENAI_API_KEY: 'sk' }, {
    realtimeSpeak: async (o) => { assert.equal(o.voice, 'cedar'); return { wav: pcm16ToWav(PCM_1S), transcript: 'Hello there.' }; },
  }).speak('Hello there.', { voice: 'cedar', style: 'warm' });
  assert.equal(out.model, 'gpt-realtime-2.1-mini');
  assert.equal(out.seconds, 1);
  assert.equal(out.verbatim, 1);
  assert.equal(ai.calls.speech.length, 0);
});

test('speech provider: paraphrase or failure falls back to /v1/audio/speech; no fallback → error', async () => {
  const wavRes = { arrayBuffer: async () => pcm16ToWav(Buffer.alloc(48000)).buffer.slice(0) };
  const ai = fakeOpenAI({ speech: async () => wavRes });
  const para = await speechProvider(ai, {}, {
    realtimeSpeak: async () => ({ wav: pcm16ToWav(PCM_1S), transcript: 'What a fascinating dream! Let me tell you about it.' }),
  }).speak('I was standing by the sea.');
  assert.equal(para.model, 'gpt-4o-mini-tts');
  assert.equal(ai.calls.speech[0].response_format, 'wav');
  assert.equal(ai.calls.speech[0].voice, 'marin');
  const fail = await speechProvider(ai, {}, { realtimeSpeak: async () => { throw new Error('realtime error'); } }).speak('Hi.');
  assert.equal(fail.model, 'gpt-4o-mini-tts');
  await assert.rejects(speechProvider(ai, { TTS_FALLBACK_MODEL: '' }, { realtimeSpeak: async () => { throw new Error('x'); } }).speak('Hi.'));
});

test('realtime adapter surfaces server errors and timeouts', async () => {
  const errWS = fakeSocket((ws) => ws.emit({ type: 'error', error: { message: 'invalid model' } }));
  await assert.rejects(realtimeSpeak({ apiKey: 'k', model: 'm', voice: 'v', style: '', text: 'x', WebSocketImpl: errWS }), /invalid model/);
  const silentWS = fakeSocket(() => {});
  await assert.rejects(realtimeSpeak({ apiKey: 'k', model: 'm', voice: 'v', style: '', text: 'x', WebSocketImpl: silentWS, timeoutMs: 50 }), /timed out/);
});

test('verbatim score: same words pass, a chatty answer fails', () => {
  assert.equal(verbatimScore('I was standing by the sea.', 'I was standing by the sea'), 1);
  assert.ok(verbatimScore('I was standing by the sea.', 'Sure! Here it is: I was standing by the sea. What a lovely dream, tell me more about it.') < 0.8);
});

// ---- Costs ------------------------------------------------------------------------------------
test('cost lines name provider, model, billing unit, usage and cost', () => {
  const l = usageLine({ part: 'video', provider: 'fal', model: 'fal-ai/kling-video/o1/reference-to-video', unit: 'video second', quantity: 5, unitPrice: 0.112 });
  assert.deepEqual(l, { part: 'video', provider: 'fal', model: 'fal-ai/kling-video/o1/reference-to-video', unit: 'video second', quantity: 5, unit_price_usd: 0.112, usd: 0.56 });
  const u = units({});
  assert.equal(u.scenicPerSecond, 0.07);
  assert.equal(u.identityPerSecond, 0.112);
  assert.equal(u.transcribePerMinute, 0.0045);
  const free = estimateReel({ shots: 3, identityShots: 2, references: 3 });
  assert.ok(Math.abs(free.parts.video - 1.47) < 1e-9);
});
