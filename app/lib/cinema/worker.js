// Keeps a cinematic production moving between server functions.
// Each worker run lasts at most ~4½ minutes (Vercel's limit is 5); if the film isn't
// finished it hands over to a fresh run through a private, secret-protected route.
import { timingSafeEqual } from 'node:crypto';
import { siteUrl } from '@/lib/brand';

export const WORKER_PATH = '/api/internal/production';

export function workerConfigured() {
  return Boolean(process.env.REEL_WORKER_SECRET && process.env.REEL_WORKER_SECRET.length >= 24);
}

/** Our own address. Prefer configured values over anything taken from a request. */
function baseUrl(fallbackOrigin) {
  if (process.env.REEL_WORKER_URL) return process.env.REEL_WORKER_URL.replace(/\/+$/, '');
  if (siteUrl()) return siteUrl();
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return fallbackOrigin || null;
}

/** Starts (or continues) the worker for one dream. Returns once the worker has accepted it. */
export async function kickWorker(dreamId, fallbackOrigin) {
  const base = baseUrl(fallbackOrigin);
  if (!base || !workerConfigured()) return false;
  try {
    const res = await fetch(`${base}${WORKER_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-worker-secret': process.env.REEL_WORKER_SECRET },
      body: JSON.stringify({ dreamId }),
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    return res.status === 202;
  } catch (e) {
    console.error('worker kick failed', e?.message || e);
    return false;
  }
}

/** Constant-time check of the shared secret on the worker route. */
export function isWorkerRequest(req) {
  if (!workerConfigured()) return false;
  const got = Buffer.from(req.headers.get('x-worker-secret') || '');
  const want = Buffer.from(process.env.REEL_WORKER_SECRET);
  return got.length === want.length && timingSafeEqual(got, want);
}
