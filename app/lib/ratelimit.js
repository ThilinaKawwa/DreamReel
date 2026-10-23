// Separate, server-side rate limits per activity. Counted from analytics_events,
// which people can add to but never edit or delete, so the counts can't be reset.
import { getServiceSupabase } from '@/lib/server';

export const LIMITS = {
  dream: { event: 'dream_generation_started', max: Number(process.env.RL_DREAMS_PER_HOUR || 6), windowSec: 3600 },
  reelRetry: { event: 'reel_render_started', max: Number(process.env.RL_REEL_RENDERS_PER_HOUR || 6), windowSec: 3600 },
  guruChat: { event: 'guru_response_completed', max: Number(process.env.RL_GURU_PER_HOUR || 40), windowSec: 3600 },
  guruVoice: { event: 'guru_voice_started', max: Number(process.env.RL_GURU_VOICE_PER_HOUR || 40), windowSec: 3600 },
};

/** true when this person is still under the limit for this activity. */
export async function underLimit(userId, key) {
  const rule = LIMITS[key];
  if (!rule) return true;
  let admin;
  try { admin = getServiceSupabase(); } catch { return true; } // not configured: other caps still apply
  const since = new Date(Date.now() - rule.windowSec * 1000).toISOString();
  const { count, error } = await admin.from('analytics_events').select('id', { count: 'exact', head: true })
    .eq('user_id', userId).eq('event', rule.event).gte('created_at', since);
  if (error) return true;
  return (count || 0) < rule.max;
}
