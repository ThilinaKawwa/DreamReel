import { json, requireUser, getServiceSupabase } from '@/lib/server';
import { MEDIA_BUCKET } from '@/lib/cinema/media';

export const runtime = 'nodejs';

// Internal cost/quality diagnostics. Only for accounts listed in ADMIN_USER_IDS (server env,
// comma-separated Supabase user ids). Everyone else gets a 404. Never returns dream text.
function isAdmin(userId) {
  return String(process.env.ADMIN_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean).includes(userId);
}

export async function GET(req) {
  const auth = await requireUser(req);
  if (!auth || !isAdmin(auth.user.id)) return json({ error: 'Not found.' }, 404);
  const admin = getServiceSupabase();
  const day = new Date().toISOString().slice(0, 10);
  const cap = Math.round(Number(process.env.REEL_DAILY_BUDGET_USD || 25) * 100);
  const [{ data: budget }, { data: rows }] = await Promise.all([
    admin.from('generation_budget').select('*').eq('day', day).maybeSingle(),
    admin.from('dream_productions')
      .select('dream_id, user_id, env, tier, status, stage, renderer_type, generation_version, meta, cost, cost_cents, budget_reserved_cents, error, assets, usage, started_at, completed_at')
      .order('started_at', { ascending: false }).limit(50),
  ]);
  // Admin-only 1-hour links to finished test reels, for quality review.
  const links = {};
  await Promise.all((rows || []).filter((r) => r.status === 'completed').slice(0, 20).map(async (r) => {
    const { data } = await admin.storage.from(MEDIA_BUCKET).createSignedUrl(`${r.user_id}/${r.dream_id}/reel.mp4`, 3600);
    if (data?.signedUrl) links[r.dream_id] = data.signedUrl;
  }));
  const productions = (rows || []).map((r) => ({
    review_url: links[r.dream_id] || null,
    dream_id: r.dream_id, env: r.env, tier: r.tier, status: r.status, stage: r.stage,
    renderer_type: r.renderer_type, generation_version: r.generation_version, meta: r.meta,
    cost_cents: r.cost_cents, cost_breakdown_cents: r.cost, reserved_cents: r.budget_reserved_cents,
    // Per provider/model/billing unit: estimated usage and estimated cost (list prices, see lib/cinema/costs.js).
    usage_summary: summarise(r.usage || []),
    usage_lines: r.usage || [],
    error: r.error, last_error: r.assets?.lastError || null,
    shots: Object.entries(r.assets?.clips || {}).map(([id, c]) => ({
      id, mode: c.mode, provider: c.provider, model: c.model, attempts: c.attempts, status: c.status, error: c.error || null, seconds: c.seconds || null,
    })),
    references: Object.fromEntries(Object.entries(r.assets?.references || {}).map(([k, v]) => [k, { ok: Boolean(v.path), attempts: v.attempts }])),
    started_at: r.started_at, completed_at: r.completed_at,
  }));
  return json({
    budget: {
      day, cap_cents: cap,
      spent_cents: budget?.spent_cents || 0, reserved_cents: budget?.reserved_cents || 0,
      remaining_cents: Math.max(0, cap - (budget?.spent_cents || 0) - (budget?.reserved_cents || 0)),
      blocked: budget?.blocked || 0,
    },
    productions,
  });
}

function summarise(lines) {
  const by = {};
  for (const l of lines) {
    const k = `${l.provider}|${l.model}|${l.unit}`;
    by[k] ||= { provider: l.provider, model: l.model, billing_unit: l.unit, estimated_usage: 0, estimated_usd: 0, calls: 0 };
    by[k].estimated_usage = Math.round((by[k].estimated_usage + (l.quantity || 0)) * 1000) / 1000;
    by[k].estimated_usd = Math.round((by[k].estimated_usd + (l.usd || 0)) * 10000) / 10000;
    by[k].calls += 1;
  }
  return Object.values(by);
}
