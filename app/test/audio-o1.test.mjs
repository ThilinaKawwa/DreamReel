// Final pre-real-test checks: Kling O1 request schema, TranscriptionProvider, SpeechProvider
// (Realtime adapter with a fake WebSocket — no paid API calls), model config, cost lines.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VIDEO_ADAPTERS, videoProvider, o1Input, o1InputCount, validO1Element, O1_MAX_INPUTS } from '../lib/providers/index.js';
import { normalizeBible } from '../lib/director/bible.js';
import { normalizeStoryboard } from '../lib/director/storyboard.js';
import { videoRequest, referencePrompt } from '../lib/director/compiler.js';
import { routeShot, referencePlan, secondaryKey } from '../lib/director/routing.js';
import { transcriptionProvider } from '../lib/audio/transcription.js';
import { speechProvider, realtimeSpeak, verbatimScore, _resetSpeechMemo, isModelUnsupported } from '../lib/audio/speech.js';
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

test('O1: character (front + three-quarter) and object (front + second angle), start frame, 9:16, 5 s', () => {
  const shot = board.shots[0];
  const route = routeShot(board, shot, {});
  assert.equal(route.mode, 'identity');
  assert.equal(route.provider, 'kling-o1-ref');
  assert.deepEqual(route.identityKeys, ['character:brother_01', 'object:silver_key_01']);
  assert.equal(secondaryKey('character:brother_01'), 'character:brother_01:three_quarter');
  assert.equal(secondaryKey('object:silver_key_01'), 'object:silver_key_01:alt');
  const vr = videoRequest(bible, shot);
  const body = VIDEO_ADAPTERS['kling-o1-ref'].input({
    startImageUrl: 'https://x.supabase.co/kf.jpg', prompt: vr.prompt, duration: vr.duration,
    elements: [
      { label: vr.labels['character:brother_01'], frontal: 'https://x/front.jpg', references: ['https://x/tq.jpg'] },
      { label: vr.labels['object:silver_key_01'], frontal: 'https://x/key.jpg', references: ['https://x/key-alt.jpg'] },
    ],
  });
  assert.deepEqual(Object.keys(body).sort(), ['aspect_ratio', 'duration', 'elements', 'image_urls', 'prompt']);
  assert.deepEqual(body.image_urls, ['https://x.supabase.co/kf.jpg']);
  assert.deepEqual(body.elements, [
    { frontal_image_url: 'https://x/front.jpg', reference_image_urls: ['https://x/tq.jpg'] },
    { frontal_image_url: 'https://x/key.jpg', reference_image_urls: ['https://x/key-alt.jpg'] },
  ]);
  assert.equal(body.duration, '5');
  assert.equal(body.aspect_ratio, '9:16');
  assert.match(body.prompt, /^@Image1 is the opening frame/);
  assert.match(body.prompt, /@Element1 is the dreamer's brother \(red zip-up jacket\)/);
  assert.match(body.prompt, /@Element2 is silver key/);
  assert.equal(o1InputCount(body), 3);
  assert.equal(videoProvider('kling-o1-ref').model, 'fal-ai/kling-video/o1/reference-to-video');
  assert.equal(videoProvider('kling-o1-ref').costPerSecond, 0.112);
});

test('O1: an object with only one image is never sent as an element (no empty reference arrays)', () => {
  const body = o1Input({ startImageUrl: 's', prompt: 'x', duration: 5, elements: [
    { label: 'brother', frontal: 'f1', references: ['r1'] },
    { label: 'key', frontal: 'k1', references: [] },
    { label: 'door', frontal: 'd1' },
    { label: 'ghost', frontal: null, references: ['r'] },
  ] });
  assert.equal(body.elements.length, 1);
  assert.deepEqual(body.elements[0], { frontal_image_url: 'f1', reference_image_urls: ['r1'] });
  assert.doesNotMatch(body.prompt, /@Element2/);
  for (const e of body.elements) assert.ok(e.reference_image_urls.length >= 1 && e.reference_image_urls.length <= 3);
  assert.equal(validO1Element({ frontal: 'k1', references: [] }), false);
  assert.equal(validO1Element({ frontal: 'k1', references: ['a'] }), true);
});

test('O1: reference packs are capped at 3 per element and keep their order', () => {
  const body = o1Input({ startImageUrl: 's', prompt: 'x', duration: 5, elements: [
    { label: 'a', frontal: 'fa', references: ['a1', 'a2', 'a3', 'a4', 'a5'] },
    { label: 'b', frontal: 'fb', references: ['b1'] },
  ] });
  assert.deepEqual(body.elements.map((e) => e.reference_image_urls), [['a1', 'a2', 'a3'], ['b1']]);
});

test('O1 input limit: start + elements counted (nested references are not); 6 / 7 / 8 boundaries', () => {
  const els = (n) => Array.from({ length: n }, (_, i) => ({ label: `e${i + 1}`, frontal: `f${i + 1}`, references: [`r${i + 1}a`, `r${i + 1}b`, `r${i + 1}c`] }));
  const six = o1Input({ startImageUrl: 's', prompt: 'x', duration: 5, elements: els(5) });
  assert.equal(o1InputCount(six), 6);
  assert.equal(six.elements.length, 5, '6 total: everything kept, full 3-image packs');
  assert.ok(six.elements.every((e) => e.reference_image_urls.length === 3));
  const seven = o1Input({ startImageUrl: 's', prompt: 'x', duration: 5, elements: els(6) });
  assert.equal(o1InputCount(seven), 7);
  assert.equal(seven.elements.length, 6, '7 total: exactly at the limit, nothing dropped');
  const eight = o1Input({ startImageUrl: 's', prompt: 'x', duration: 5, elements: els(7) });
  assert.equal(o1InputCount(eight), O1_MAX_INPUTS, '8 requested → reduced to 7');
  assert.deepEqual(eight.elements.map((e) => e.frontal_image_url), ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'], 'lowest-priority (last) element dropped; higher ones untouched');
  assert.ok(eight.elements.every((e) => e.reference_image_urls.length === 3), 'identity packs not thinned');
});

test('reference plan: recurring objects get a second angle derived from their front', () => {
  const plan = referencePlan(bible, board);
  const alt = plan.find((r) => r.key === 'object:silver_key_01:alt');
  assert.ok(alt, 'second angle planned');
  assert.equal(alt.from, 'object:silver_key_01');
  assert.match(referencePrompt(bible, alt), /SAME object as in Image 1/);
  assert.ok(plan.find((r) => r.key === 'character:brother_01:three_quarter'));
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

test('speech: /v1/audio/speech with gpt-realtime-2.1-mini is tried first (no Realtime session)', async () => {
  _resetSpeechMemo();
  const wavRes = { arrayBuffer: async () => pcm16ToWav(PCM_1S).buffer.slice(0) };
  const ai = fakeOpenAI({ speech: async () => wavRes });
  let realtimeCalls = 0;
  const out = await speechProvider(ai, {}, { realtimeSpeak: async () => { realtimeCalls++; throw new Error('should not run'); } })
    .speak('I remember standing beside the ocean.', { voice: 'marin', style: 'plain' });
  assert.equal(ai.calls.speech[0].model, 'gpt-realtime-2.1-mini');
  assert.equal(ai.calls.speech[0].voice, 'marin');
  assert.equal(ai.calls.speech[0].response_format, 'wav');
  assert.equal(realtimeCalls, 0);
  assert.deepEqual([out.transport, out.model, out.provider, out.fallbackUsed, out.seconds], ['speech', 'gpt-realtime-2.1-mini', 'openai', false, 1]);
});

test('speech: only if OpenAI rejects the model on /v1/audio/speech is the Realtime adapter used (remembered)', async () => {
  _resetSpeechMemo();
  const reject = Object.assign(new Error('The model gpt-realtime-2.1-mini is not supported with this endpoint.'), { status: 400 });
  const ai = fakeOpenAI({ speech: async () => { throw reject; } });
  const deps = { realtimeSpeak: async () => ({ wav: pcm16ToWav(PCM_1S), transcript: 'Hello there.' }) };
  const out = await speechProvider(ai, {}, deps).speak('Hello there.', { voice: 'cedar' });
  assert.deepEqual([out.transport, out.fallbackUsed, out.verbatim], ['realtime', false, 1]);
  await speechProvider(ai, {}, deps).speak('Hello there.', { voice: 'cedar' });
  assert.equal(ai.calls.speech.length, 1, 'rejection remembered; the speech endpoint is not retried for that model');
});

test('speech: failures use the temporary fallback and say so; a non-model error never jumps to Realtime', async () => {
  _resetSpeechMemo();
  const wavRes = { arrayBuffer: async () => pcm16ToWav(Buffer.alloc(48000)).buffer.slice(0) };
  let n = 0;
  const ai = fakeOpenAI({ speech: async (a) => { if (a.model === 'gpt-realtime-2.1-mini' && n++ === 0) throw Object.assign(new Error('Internal server error'), { status: 500 }); return wavRes; } });
  let realtimeCalls = 0;
  const out = await speechProvider(ai, {}, { realtimeSpeak: async () => { realtimeCalls++; return {}; } }).speak('Hi.');
  assert.equal(realtimeCalls, 0);
  assert.deepEqual([out.model, out.fallbackUsed], ['gpt-4o-mini-tts', true]);
  assert.match(out.primaryError, /Internal server error/);
  _resetSpeechMemo();
  const down = fakeOpenAI({ speech: async () => { throw Object.assign(new Error('Internal server error'), { status: 500 }); } });
  await assert.rejects(speechProvider(down, { TTS_FALLBACK_MODEL: '' }).speak('Hi.'), 'no fallback configured → error, never silence');
});

test('speech: Realtime paraphrase is rejected and recorded as a fallback', async () => {
  _resetSpeechMemo();
  const wavRes = { arrayBuffer: async () => pcm16ToWav(Buffer.alloc(48000)).buffer.slice(0) };
  const ai = fakeOpenAI({ speech: async () => wavRes });
  const out = await speechProvider(ai, { TTS_TRANSPORT: 'realtime' }, {
    realtimeSpeak: async () => ({ wav: pcm16ToWav(PCM_1S), transcript: 'What a fascinating dream! Let me tell you about it.' }),
  }).speak('I was standing by the sea.');
  assert.deepEqual([out.model, out.transport, out.fallbackUsed], ['gpt-4o-mini-tts', 'speech', true]);
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
