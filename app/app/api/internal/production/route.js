import { after } from 'next/server';
import { getServiceSupabase } from '@/lib/server';
import { advanceProduction } from '@/lib/cinema/production';
import { isWorkerRequest, kickWorker } from '@/lib/cinema/worker';

// Private: only our own server calls this (shared secret). Browsers get a 404.
export const maxDuration = 300;
export const runtime = 'nodejs';

const RUN_MS = 265_000;

export async function POST(req) {
  if (!isWorkerRequest(req)) return new Response('Not found', { status: 404 });
  const { dreamId } = await req.json().catch(() => ({}));
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(dreamId || '')) {
    return new Response('Bad request', { status: 400 });
  }
  const started = Date.now();
  const origin = new URL(req.url).origin;
  after(async () => {
    const admin = getServiceSupabase();
    const result = await advanceProduction(admin, dreamId, started + RUN_MS);
    if (result === 'waiting') await kickWorker(dreamId, origin);
  });
  return new Response(null, { status: 202 });
}
