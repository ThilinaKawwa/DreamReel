// Creates the production record for a new dream (tagged with THIS deployment's environment).
import { getServiceSupabase } from '@/lib/server';
import { DIRECTOR_VERSION } from '@/lib/director/bible';
import { cinematicAvailable } from '@/lib/cinema/production';
import { kickWorker, workerConfigured, deploymentEnv } from '@/lib/cinema/worker';

/** Can this deployment make cinematic films right now? (keys + worker + database update) */
export async function cinematicReady() {
  if (!cinematicAvailable() || !workerConfigured()) return false;
  try {
    const { error } = await getServiceSupabase().from('dream_productions').select('dream_id', { head: true, count: 'exact' }).limit(1);
    return !error;
  } catch { return false; }
}

/** Records the production (awaited, so a dream is never left without one). */
export async function createProduction({ dreamId, userId, tier, creditId }) {
  const { error } = await getServiceSupabase().from('dream_productions').insert({
    dream_id: dreamId, user_id: userId, tier, credit_id: creditId || null, env: deploymentEnv(),
    generation_version: DIRECTOR_VERSION, status: 'queued', stage: 'understanding',
  });
  if (error && !/duplicate key/i.test(error.message)) throw error;
}

export { kickWorker };
