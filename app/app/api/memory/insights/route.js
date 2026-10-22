import { json, requireUser } from '@/lib/server';
import { logEvent } from '@/lib/analytics-server';
import { getEntitlements } from '@/lib/entitlements';
import { loadIndex, loadEntityStats, loadPatterns, activity } from '@/lib/memory/store';
import { memoryMotifs } from '@/lib/memory/search';

export const runtime = 'nodejs';

/** Insights: recurring people, places and themes, and the feeling of recent dreams. From stored data only. */
export async function GET(req) {
  const auth = await requireUser(req);
  if (!auth) return json({ error: 'Not signed in.' }, 401);
  const { supabase: db, user } = auth;
  const [index, stats, act, ent] = await Promise.all([loadIndex(db, user.id, 1000), loadEntityStats(db, user.id), activity(db, user.id), getEntitlements(db, user.id)]);
  const live = new Set(index.map((m) => m.dream_id));
  const patterns = await loadPatterns(db, user.id, live);
  await logEvent(db, user.id, 'insights_opened', { dreams: act.total });

  const recurring = (type) => stats.filter((e) => e.entity_type === type && e.appearances >= 2).slice(0, 8)
    .map((e) => ({ label: cap(e.label), dreams: e.appearances, sure: e.specific && e.confidence >= 0.75, lastSeen: e.last_seen }));

  const themes = new Map();
  for (const m of index) for (const x of memoryMotifs(m)) themes.set(x, (themes.get(x) || 0) + 1);
  const monthAgo = Date.now() - 30 * 86400000;
  const recent = index.filter((m) => new Date(m.dream_at).getTime() > monthAgo);
  const feelings = new Map();
  for (const m of recent) for (const f of (m.emotions || []).slice(0, 2)) feelings.set(f, (feelings.get(f) || 0) + 1);
  const topFeeling = [...feelings].sort((a, b) => b[1] - a[1])[0] || null;

  return json({
    activity: act,
    people: recurring('person'),
    places: recurring('place'),
    things: [...recurring('object'), ...recurring('creature')].sort((a, b) => b.dreams - a.dreams).slice(0, 8),
    themes: [...themes].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([label, dreams]) => ({ label: cap(label), dreams })),
    feeling: topFeeling && topFeeling[1] >= 2 ? { label: topFeeling[0], dreams: topFeeling[1], of: recent.length } : null,
    // Feelings around recurring things and trends are part of Premium.
    patterns: ent.canViewAdvancedPatterns ? patterns.filter((p) => p.pattern_type === 'entity_emotion' || p.pattern_type === 'emotion_trend').slice(0, 6).map((p) => p.description) : null,
    advancedLocked: !ent.canViewAdvancedPatterns,
    upgradeAvailable: ent.upgradeAvailable,
  });
}

const cap = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
