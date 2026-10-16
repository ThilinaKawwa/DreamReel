import { after } from 'next/server';
import { getServiceSupabase } from '@/lib/server';
import { advanceProduction } from '@/lib/cinema/production';
import { isWorkerRequest, kickWorker, deploymentEnv } from '@/lib/cinema/worker';

// Private: only this deployment's own server calls it (shared secret). Browsers get a 404.
export const maxDuration = 300;
export const runtime = 'nodejs';

const RUN_MS = 265_000;

export async function POST(req) {
  if (!isWorkerRequest(req)) return new Response('Not found', { status: 404 });
  const { dreamId, env } = await req.json().catch(() => ({}));
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(dreamId || '')) {
    return new Response('Bad request', { status: 400 });
  }
  // A job addressed to another environment is refused (production never runs preview work).
  if (env && env !== deploymentEnv()) return new Response('Wrong environment', { status: 409 });
  const started = Date.now();
  after(async () => {
    const result = await advanceProduction(getServiceSupabase(), dreamId, started + RUN_MS);
    if (result === 'waiting') await kickWorker(dreamId);
  });
  return new Response(null, { status: 202 });
}
