// THE one place that decides what a person may do. Server-side only.
// The plan comes from `profiles` (written only by the Stripe webhook) — never from the browser.
// Credits are counted and claimed in the database (reel_credits), with the service role.
import { getProfile, isPremium, getServiceSupabase } from '@/lib/server';
import { accessPlans, creditPeriod, shareMode } from '@/lib/access-config';

export { accessPlans, creditPeriod };

function admin() {
  try { return getServiceSupabase(); } catch { return null; }
}

/** Everything the app needs to know about this person's access, resolved server-side. */
export async function getEntitlements(supabase, userId) {
  const profile = await getProfile(supabase, userId);
  const premium = isPremium(profile);
  const plan = accessPlans()[premium ? 'premium' : 'free'];
  const period = creditPeriod(plan);
  let used = null;
  const db = admin();
  if (db) {
    const { count, error } = await db.from('reel_credits').select('id', { count: 'exact', head: true })
      .eq('user_id', userId).eq('plan', plan.creditPlan).eq('period', period).eq('status', 'active');
    if (!error) used = count || 0;
  }
  const reelsLeft = used === null ? null : Math.max(0, plan.cinematicReels - used);
  return {
    ...plan,
    creditPeriod: period,
    reelsUsed: used,
    reelsLeft,
    canGenerateReel: reelsLeft === null ? false : reelsLeft > 0,
    shareMode: shareMode(plan),
    upgradeAvailable: Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID),
    renewsAt: premium ? profile.current_period_end || null : null,
  };
}

/** Takes (or re-uses) this dream's credit. Returns the credit id, or null if none are left. */
export async function claimCredit(userId, dreamId, ent) {
  const db = admin();
  if (!db) return { error: 'not configured' };
  const { data, error } = await db.rpc('claim_reel_credit', {
    p_user: userId, p_dream: dreamId, p_plan: ent.creditPlan, p_period: ent.creditPeriod, p_limit: ent.cinematicReels,
  });
  if (error) return { error: error.message };
  return { creditId: data || null };
}

/** Gives a credit back when no usable reel was made (capped against abuse). */
export async function refundCredit(creditId, tier) {
  if (!creditId) return false;
  const db = admin();
  if (!db) return false;
  const plan = accessPlans()[tier === 'premium' ? 'premium' : 'free'];
  const { data, error } = await db.rpc('refund_reel_credit', { p_credit: creditId, p_max_refunds: plan.maxRefunds });
  if (error) { console.error('refund failed', error.message); return false; }
  return Boolean(data);
}
