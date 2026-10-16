// Keeps a cinematic production moving between server functions, inside ONE environment.
// Each run lasts at most ~4½ minutes (Vercel's limit is 5); unfinished work is handed to a
// fresh run of THIS deployment's private worker route (see lib/cinema/env.js).
import { timingSafeEqual } from 'node:crypto';
import { resolveWorkerTarget, deploymentEnv } from '@/lib/cinema/env';

export const WORKER_PATH = '/api/internal/production';
export { deploymentEnv };

export function workerConfigured() {
  return Boolean(process.env.REEL_WORKER_SECRET && process.env.REEL_WORKER_SECRET.length >= 24);
}

/**
 * Starts (or continues) the worker for one dream in this environment.
 * Returns 'sent' | 'inline' | 'unavailable'.
 */
export async function kickWorker(dreamId) {
  if (!workerConfigured()) return 'unavailable';
  const target = resolveWorkerTarget();
  if (!target.url) {
    if (target.env === 'development') {
      // Local development: run in this process instead of calling any other server.
      const { runInline } = await import('@/lib/cinema/inline');
      runInline(dreamId);
      return 'inline';
    }
    console.error('worker not reachable:', target.reason);
    return 'unavailable';
  }
  try {
    const res = await fetch(`${target.url}${WORKER_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-worker-secret': process.env.REEL_WORKER_SECRET, ...target.headers },
      body: JSON.stringify({ dreamId, env: target.env }),
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    if (res.status !== 202) console.error('worker refused', res.status);
    return res.status === 202 ? 'sent' : 'unavailable';
  } catch (e) {
    console.error('worker kick failed', e?.message || e);
    return 'unavailable';
  }
}

/** Constant-time check of the shared secret on the worker route. */
export function isWorkerRequest(req) {
  if (!workerConfigured()) return false;
  const got = Buffer.from(req.headers.get('x-worker-secret') || '');
  const want = Buffer.from(process.env.REEL_WORKER_SECRET);
  return got.length === want.length && timingSafeEqual(got, want);
}
