// Replicate adapter: request shape, auth, retries on 429/5xx/timeouts, caching, status mapping.
// Uses a fake fetch — no real network or money.
import test from 'node:test';
import assert from 'node:assert/strict';
import { replicateClient, replicateVideoProvider, replicateKlingInput, mapPrediction, backoffMs, ProviderError, REPLICATE_KLING_25 } from '../lib/providers/replicate.js';
import { videoProvider } from '../lib/providers/index.js';
import { allowedProviderUrl } from '../lib/cinema/media.js';

const json = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => body, text: async () => JSON.stringify(body),
});
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return r;
  };
  fn.calls = calls;
  return fn;
}
const noSleep = async () => {};

test('submit: correct endpoint, bearer auth, Kling inputs, backend-only token', async () => {
  const f = fakeFetch([json(201, { id: 'abc123xyz', status: 'starting' })]);
  const c = replicateClient({ token: 'r8_test', fetchImpl: f, sleep: noSleep });
  const out = await c.createPrediction(REPLICATE_KLING_25, replicateKlingInput({ startImageUrl: 'https://x/kf.jpg', prompt: 'water rises', negative: 'text', duration: 5 }));
  assert.equal(out.id, 'abc123xyz');
  assert.equal(f.calls[0].url, 'https://api.replicate.com/v1/models/kwaivgi/kling-v2.5-turbo-pro/predictions');
  assert.equal(f.calls[0].init.method, 'POST');
  assert.equal(f.calls[0].init.headers.authorization, 'Bearer r8_test');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { input: { prompt: 'water rises', start_image: 'https://x/kf.jpg', duration: 5, negative_prompt: 'text' } });
});

test('identical submit within the cache window is not charged twice', async () => {
  const f = fakeFetch([json(201, { id: 'first0001' })]);
  const c = replicateClient({ token: 't', fetchImpl: f, sleep: noSleep });
  const input = replicateKlingInput({ startImageUrl: 'https://x/a.jpg', prompt: 'p', duration: 5 });
  await c.createPrediction(REPLICATE_KLING_25, input);
  const again = await c.createPrediction(REPLICATE_KLING_25, input);
  assert.equal(again.id, 'first0001');
  assert.equal(again.cached, true);
  assert.equal(f.calls.length, 1);
});

test('429 is retried, honouring Retry-After; then succeeds', async () => {
  const waits = [];
  const f = fakeFetch([json(429, { detail: 'Request was throttled.' }, { 'retry-after': '3' }), json(201, { id: 'ok0000001' })]);
  const c = replicateClient({ token: 't', fetchImpl: f, sleep: async (ms) => waits.push(ms) });
  const out = await c.createPrediction(REPLICATE_KLING_25, { prompt: 'x' });
  assert.equal(out.id, 'ok0000001');
  assert.deepEqual(waits, [3000]);
});

test('timeouts and 5xx retry up to 4 tries, then fail clearly', async () => {
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const f = fakeFetch([timeout, json(502, { detail: 'bad gateway' }), json(503, {}), json(500, {})]);
  const c = replicateClient({ token: 't', fetchImpl: f, sleep: noSleep });
  await assert.rejects(c.createPrediction(REPLICATE_KLING_25, { prompt: 'y' }), (e) => e instanceof ProviderError && e.status === 500 && e.retryable);
  assert.equal(f.calls.length, 4);
});

test('4xx errors (bad input, bad token) are not retried', async () => {
  const f = fakeFetch([json(422, { detail: 'start_image is not a valid URL' })]);
  const c = replicateClient({ token: 't', fetchImpl: f, sleep: noSleep });
  await assert.rejects(c.createPrediction(REPLICATE_KLING_25, { prompt: 'z' }), /422: start_image is not a valid URL/);
  assert.equal(f.calls.length, 1);
  await assert.rejects(replicateClient({ token: '', fetchImpl: f }).createPrediction(REPLICATE_KLING_25, {}), /REPLICATE_API_TOKEN is not set/);
});

test('finished predictions are cached; running ones are polled again', async () => {
  const f = fakeFetch([json(200, { id: 'p00000001', status: 'processing' }), json(200, { id: 'p00000001', status: 'succeeded', output: 'https://replicate.delivery/x/out.mp4' })]);
  const c = replicateClient({ token: 't', fetchImpl: f, sleep: noSleep });
  assert.equal((await c.getPrediction('p00000001')).status, 'processing');
  assert.equal((await c.getPrediction('p00000001')).status, 'succeeded');
  assert.equal((await c.getPrediction('p00000001')).status, 'succeeded');
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].url, 'https://api.replicate.com/v1/predictions/p00000001');
  await assert.rejects(c.getPrediction('../../secrets'), /bad prediction id/);
});

test('status mapping and provider behaviour', async () => {
  assert.deepEqual(mapPrediction({ status: 'starting' }), { status: 'pending' });
  assert.deepEqual(mapPrediction({ status: 'succeeded', output: 'https://replicate.delivery/a.mp4' }), { status: 'done', url: 'https://replicate.delivery/a.mp4' });
  assert.deepEqual(mapPrediction({ status: 'succeeded', output: ['https://replicate.delivery/b.mp4'] }), { status: 'done', url: 'https://replicate.delivery/b.mp4' });
  assert.equal(mapPrediction({ status: 'failed', error: 'NSFW' }).error, 'NSFW');
  assert.equal(mapPrediction({ status: 'canceled' }).status, 'failed');
  assert.equal(mapPrediction({ status: 'succeeded', output: null }).status, 'failed');

  // A throttle while polling stays "pending" (no wasted shot retry); a hard error fails the shot.
  const throttled = { getPrediction: async () => { throw new ProviderError('Replicate 429', { status: 429, retryable: true }); } };
  assert.deepEqual(await replicateVideoProvider({ client: throttled, env: { PRICE_REPLICATE_KLING_25_PER_S: '0.07' } }).check('abcdefgh1'), { status: 'pending' });
  const broken = { getPrediction: async () => { throw new ProviderError('Replicate 404: not found', { status: 404 }); } };
  assert.equal((await replicateVideoProvider({ client: broken, env: { PRICE_REPLICATE_KLING_25_PER_S: '0.07' } }).check('abcdefgh1')).status, 'failed');
});

test('price must be configured (budget safety); provider is reachable through videoProvider()', async () => {
  const unpriced = replicateVideoProvider({ client: { createPrediction: async () => ({ id: 'x' }) }, env: {} });
  assert.equal(unpriced.costPerSecond, null);
  await assert.rejects(unpriced.submit({ startImageUrl: 'https://x', prompt: 'p', duration: 5 }), /PRICE_REPLICATE_KLING_25_PER_S/);
  assert.equal(videoProvider('replicate-kling-i2v').id, 'replicate-kling-i2v');
  assert.equal(videoProvider('kling-i2v').id, 'kling-i2v', 'fal stays the default');
});

test('Replicate output host is allowed for download; look-alikes are not', () => {
  assert.ok(allowedProviderUrl('https://replicate.delivery/xezq/out.mp4'));
  assert.ok(allowedProviderUrl('https://pbxt.replicate.delivery/out.mp4'));
  assert.ok(!allowedProviderUrl('https://replicate.delivery.evil.com/out.mp4'));
  assert.ok(!allowedProviderUrl('http://replicate.delivery/out.mp4'));
});

test('backoff: Retry-After wins, otherwise grows and is capped', () => {
  assert.equal(backoffMs(0, '2'), 2000);
  assert.ok(backoffMs(0) >= 1000 && backoffMs(0) < 1300);
  assert.ok(backoffMs(10) <= 16_250);
});
