// Replicate video adapter — a second, optional provider behind the same VideoProvider
// interface as fal (submit → requestId, check → pending | done | failed). Server-only:
// the token is read from REPLICATE_API_TOKEN and never reaches the browser.
//
// Contract (Replicate HTTP API reference, https://replicate.com/docs/reference/http):
//   POST {base}/v1/models/{owner}/{name}/predictions   body { input }   Authorization: Bearer <token>
//   GET  {base}/v1/predictions/{id}                    → { id, status, output, error }
//   status: starting | processing | succeeded | failed | canceled
//   Create-prediction limit 600 requests/min; throttled requests return HTTP 429.
// Model: kwaivgi/kling-v2.5-turbo-pro — inputs prompt, start_image, negative_prompt, duration
// (5|10), aspect_ratio (ignored when start_image is given); output is a video URL.
import { createHash } from 'node:crypto';

export const REPLICATE_BASE = 'https://api.replicate.com';
export const REPLICATE_KLING_25 = 'kwaivgi/kling-v2.5-turbo-pro';

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_TRIES = 4;
const SUBMIT_CACHE_MS = 10 * 60 * 1000; // identical request within 10 min → same prediction, not a second charge
const RESULT_CACHE_MS = 60 * 60 * 1000; // finished predictions don't change

export class ProviderError extends Error {
  constructor(message, { status = null, retryable = false } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

/** Small time-bounded cache (per server process). Exported for tests. */
export function ttlCache(max = 500) {
  const map = new Map();
  return {
    get(k) {
      const hit = map.get(k);
      if (!hit) return undefined;
      if (hit.exp < Date.now()) { map.delete(k); return undefined; }
      return hit.v;
    },
    set(k, v, ttl) {
      if (map.size >= max) map.delete(map.keys().next().value);
      map.set(k, { v, exp: Date.now() + ttl });
    },
    clear() { map.clear(); },
  };
}

/** Wait before retry: Retry-After header (seconds) if present, else exponential backoff with jitter. */
export function backoffMs(attempt, retryAfter) {
  const s = Number(retryAfter);
  if (Number.isFinite(s) && s >= 0) return Math.min(30_000, s * 1000);
  return Math.min(16_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

/** Maps our provider-independent shot request onto the Replicate Kling 2.5 inputs. Pure. */
export function replicateKlingInput({ startImageUrl, prompt, negative, duration }) {
  const input = { prompt, start_image: startImageUrl, duration: duration >= 10 ? 10 : 5 };
  if (negative) input.negative_prompt = negative;
  return input;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.token]       defaults to process.env.REPLICATE_API_TOKEN
 * @param {Function} [opts.fetchImpl] injectable for tests
 * @param {Function} [opts.sleep]     injectable for tests
 */
export function replicateClient({ token = process.env.REPLICATE_API_TOKEN, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), base = REPLICATE_BASE } = {}) {
  const submits = ttlCache();
  const results = ttlCache();

  async function call(path, init = {}) {
    if (!token) throw new ProviderError('REPLICATE_API_TOKEN is not set', { retryable: false });
    let last;
    for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
      let res;
      try {
        res = await fetchImpl(`${base}${path}`, {
          ...init,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          redirect: 'error',
        });
      } catch (e) {
        // Network failure or timeout: safe to retry for GET; for POST we retry too because an
        // identical body is cached on success, and Replicate returns the new prediction id each time.
        last = new ProviderError(e?.name === 'TimeoutError' ? 'Replicate request timed out' : `Replicate unreachable: ${e?.message || e}`, { retryable: true });
        await sleep(backoffMs(attempt));
        continue;
      }
      if (res.ok) return res.json();
      const body = await res.text().catch(() => '');
      const detail = (() => { try { return JSON.parse(body).detail || body; } catch { return body; } })();
      const retryable = res.status === 429 || res.status >= 500 || res.status === 408;
      last = new ProviderError(`Replicate ${res.status}: ${String(detail).slice(0, 200)}`, { status: res.status, retryable });
      if (!retryable) throw last;
      await sleep(backoffMs(attempt, res.headers?.get?.('retry-after')));
    }
    throw last;
  }

  return {
    /** Creates a prediction (deduplicated for identical requests). Returns { id }. */
    async createPrediction(model, input) {
      const key = createHash('sha256').update(model + JSON.stringify(input)).digest('hex');
      const cached = submits.get(key);
      if (cached) return { id: cached, cached: true };
      const p = await call(`/v1/models/${model}/predictions`, { method: 'POST', body: JSON.stringify({ input }) });
      if (!p?.id) throw new ProviderError('Replicate returned no prediction id');
      submits.set(key, p.id, SUBMIT_CACHE_MS);
      return { id: p.id };
    },
    /** Reads a prediction; finished ones are cached. */
    async getPrediction(id) {
      if (!/^[a-z0-9]{8,64}$/i.test(String(id))) throw new ProviderError('bad prediction id');
      const hit = results.get(id);
      if (hit) return hit;
      const p = await call(`/v1/predictions/${id}`);
      if (['succeeded', 'failed', 'canceled'].includes(p?.status)) results.set(id, p, RESULT_CACHE_MS);
      return p;
    },
  };
}

/** Prediction → our status shape. Pure. */
export function mapPrediction(p) {
  if (!p || ['starting', 'processing'].includes(p.status)) return { status: 'pending' };
  if (p.status === 'succeeded') {
    const url = Array.isArray(p.output) ? p.output[0] : p.output;
    return typeof url === 'string' && url.startsWith('https://') ? { status: 'done', url } : { status: 'failed', error: 'no video in result' };
  }
  return { status: 'failed', error: String(p.error || p.status || 'failed').slice(0, 200) };
}

/**
 * VideoProvider for Replicate's Kling 2.5 Turbo Pro (scenic, first-frame image-to-video).
 * Replicate's per-second price for this model was NOT verified, so it must be configured:
 * without PRICE_REPLICATE_KLING_25_PER_S the provider refuses to submit (the budget cap
 * needs a real number).
 */
export function replicateVideoProvider({ client = replicateClient(), env = process.env } = {}) {
  const price = Number(env.PRICE_REPLICATE_KLING_25_PER_S);
  return {
    id: 'replicate-kling-i2v',
    model: `replicate:${REPLICATE_KLING_25}`,
    referenceConditioned: false,
    costPerSecond: Number.isFinite(price) && price > 0 ? price : null,
    async submit(req) {
      if (!(Number.isFinite(price) && price > 0)) throw new ProviderError('PRICE_REPLICATE_KLING_25_PER_S must be set before using Replicate');
      const { id } = await client.createPrediction(REPLICATE_KLING_25, replicateKlingInput(req));
      return { requestId: id };
    },
    async check(requestId) {
      try {
        return mapPrediction(await client.getPrediction(requestId));
      } catch (e) {
        // A throttle/outage while polling is "still pending", not a failed shot (no wasted retry).
        if (e instanceof ProviderError && e.retryable) return { status: 'pending' };
        return { status: 'failed', error: String(e?.message || e).slice(0, 200) };
      }
    },
  };
}
