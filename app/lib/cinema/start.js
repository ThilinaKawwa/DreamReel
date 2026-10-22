// Creates the production record for a new dream (tagged with THIS deployment's environment).
import { after } from 'next/server';
import { getServiceSupabase } from '@/lib/server';
import { claimCredit, refundCredit } from '@/lib/entitlements';
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

/**
 * Takes this dream's credit (atomically, in the database) and starts the Dream Director
 * production in THIS deployment's environment. Used for new recordings and for saved
 * Guru dreams the person chooses to visualize — the same pipeline, never a second one.
 * Returns { ok } or { ok: false, reason: 'no_credits' | 'error' }.
 */
export async function startCinematic({ userId, dreamId, ent }) {
  const claim = await claimCredit(userId, dreamId, ent);
  if (!claim.creditId) {
    if (claim.error) console.error('credit claim failed', claim.error);
    return { ok: false, reason: claim.error ? 'error' : 'no_credits' };
  }
  try {
    await createProduction({ dreamId, userId, tier: ent.generationTier, creditId: claim.creditId });
    after(() => kickWorker(dreamId));
    return { ok: true };
  } catch (e) {
    console.error('could not start production', e);
    await refundCredit(claim.creditId, ent.generationTier);
    return { ok: false, reason: 'error' };
  }
}

export { kickWorker };
