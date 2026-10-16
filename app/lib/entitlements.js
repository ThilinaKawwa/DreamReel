// THE one place that decides what a person may do. Server-side only.
// Plan comes from `profiles` (written only by the Stripe webhook) — never from the browser.
import { getProfile, isPremium } from '@/lib/server';

// Sharing is its own entitlement, separate from downloading, so free sharing can be
// turned on later as a growth loop without also giving away the file.
//   'none' — no sharing · 'link' — opt-in public page (no file) · 'file' — share the MP4 itself
const SHARE_MODES = ['none', 'link', 'file'];
const shareMode = (v, fallback) => (SHARE_MODES.includes(v) ? v : fallback);

export const ACCESS = {
  free: {
    plan: 'free',
    dailyReelLimit: 1,
    canDownload: false,
    shareMode: shareMode(process.env.FREE_SHARE_MODE, 'link'),
    canUseGuru: false,
    generationTier: 'free', // 3 cinematic shots
  },
  premium: {
    plan: 'premium',
    dailyReelLimit: 3, // keep in sync with reel_daily_limit() in the 20261017 migration
    canDownload: true,
    shareMode: shareMode(process.env.PREMIUM_SHARE_MODE, 'file'),
    canUseGuru: true,
    generationTier: 'premium', // 5 cinematic shots
  },
};

/** Everything the app needs to know about this person's access, resolved server-side. */
export async function getEntitlements(supabase, userId) {
  const profile = await getProfile(supabase, userId);
  const premium = isPremium(profile);
  const base = premium ? ACCESS.premium : ACCESS.free;
  let reelsLeftToday = null;
  const { data, error } = await supabase.rpc('reels_left_today');
  if (!error && typeof data === 'number') reelsLeftToday = data;
  return {
    ...base,
    canGenerateReel: reelsLeftToday === null ? true : reelsLeftToday > 0,
    reelsLeftToday,
    upgradeAvailable: Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID),
    renewsAt: premium ? profile.current_period_end || null : null,
  };
}

/** Shot plan per tier — the main cost lever (see README "Costs"). */
export const TIER_PLAN = {
  free: { maxShots: Number(process.env.FREE_MAX_SHOTS || 3) },
  premium: { maxShots: Number(process.env.PREMIUM_MAX_SHOTS || 5) },
};
