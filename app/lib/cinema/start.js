// Creates the production record for a new dream and starts the worker.
import { getServiceSupabase } from '@/lib/server';
import { DIRECTOR_VERSION } from '@/lib/director/bible';
import { cinematicAvailable } from '@/lib/cinema/production';
import { kickWorker, workerConfigured } from '@/lib/cinema/worker';

/** Can this server make cinematic films right now? (keys + worker + database update) */
export async function cinematicReady() {
  if (!cinematicAvailable() || !workerConfigured()) return false;
  try {
    const { error } = await getServiceSupabase().from('dream_productions').select('dream_id', { head: true, count: 'exact' }).limit(1);
    return !error;
  } catch { return false; }
}

/** Records the production (awaited, so a dream is never left without one). */
export async function createProduction({ dreamId, userId, tier, quotaId }) {
  const admin = getServiceSupabase();
  const { error } = await admin.from('dream_productions').insert({
    dream_id: dreamId, user_id: userId, tier, quota_id: quotaId || null,
    generation_version: DIRECTOR_VERSION, status: 'queued', stage: 'understanding',
  });
  if (error && !/duplicate key/i.test(error.message)) throw error;
}

export { kickWorker };

/** Gives a slot back when a dream fails before any expensive work (at most twice a day). */
export async function releaseSlot(quotaId) {
  if (!quotaId) return;
  try {
    const admin = getServiceSupabase();
    const { data: q } = await admin.from('reel_quota').select('user_id, day').eq('id', quotaId).maybeSingle();
    if (!q) return;
    const { count } = await admin.from('reel_quota').select('id', { count: 'exact', head: true })
      .eq('user_id', q.user_id).eq('day', q.day).eq('released', true);
    if ((count || 0) < 2) await admin.from('reel_quota').update({ released: true }).eq('id', quotaId);
  } catch (e) { console.error('release slot failed', e?.message || e); }
}
