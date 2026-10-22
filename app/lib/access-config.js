// Product access and economics — the ONE place to change what each plan gets.
// Pure (no imports), so it can be unit-tested. Read only on the server; the browser
// only ever sees the resolved answer from /api/me/entitlements.

const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);
const flag = (v, d) => (v == null || v === '' ? d : v === 'true');

export function accessPlans(env = process.env) {
  return {
    free: {
      plan: 'free',
      creditPlan: 'trial',
      cinematicReels: num(env.FREE_TRIAL_REELS, 1),            // lifetime, not per day
      period: 'lifetime',
      maxRefunds: num(env.FREE_TRIAL_MAX_REFUNDS, 2),          // failed trials given back, lifetime
      maxShots: num(env.FREE_MAX_SHOTS, 3),
      canDownload: false,
      canShareLink: flag(env.FREE_CAN_SHARE_LINK, true),        // branded link to the dream page
      canShareFile: flag(env.FREE_CAN_SHARE_FILE, false),       // the MP4 itself
      // Dream Guru V2: everyone talks to Orin; the allowance and depth differ by plan.
      canUseGuru: true,
      guruTextPerDay: num(env.FREE_GURU_TEXT_PER_DAY, 20),     // typed messages per rolling 24 h
      guruVoicePerDay: num(env.FREE_GURU_VOICE_PER_DAY, 8),    // spoken messages per rolling 24 h
      recallDepth: num(env.FREE_RECALL_DREAMS, 30),            // most recent dreams Orin can draw on (all stay saved and visible)
      canViewAdvancedPatterns: false,                          // feelings around recurring things, trends
      canUseGuruReading: false,                                // the older long-form reading (lib/guru.js)
      generationTier: 'free',
    },
    premium: {
      plan: 'premium',
      creditPlan: 'premium',
      cinematicReels: num(env.PREMIUM_MONTHLY_REELS, 4),       // per UK calendar month
      period: 'monthly',
      maxRefunds: num(env.PREMIUM_MAX_REFUNDS_PER_MONTH, 3),
      maxShots: num(env.PREMIUM_MAX_SHOTS, 5),
      canDownload: true,
      canShareLink: flag(env.PREMIUM_CAN_SHARE_LINK, true),
      canShareFile: flag(env.PREMIUM_CAN_SHARE_FILE, true),
      canUseGuru: true,
      guruTextPerDay: num(env.PREMIUM_GURU_TEXT_PER_DAY, 150),
      guruVoicePerDay: num(env.PREMIUM_GURU_VOICE_PER_DAY, 80),
      recallDepth: num(env.PREMIUM_RECALL_DREAMS, 1000),
      canViewAdvancedPatterns: true,
      canUseGuruReading: true,
      generationTier: 'premium',
    },
  };
}

/** 'lifetime' for the trial, '2026-10' (UK calendar month) for Premium. */
export function creditPeriod(plan, date = new Date()) {
  if (plan.period === 'lifetime') return 'lifetime';
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit' }).formatToParts(date);
  const y = parts.find((p) => p.type === 'year').value;
  const m = parts.find((p) => p.type === 'month').value;
  return `${y}-${m}`;
}

/** What the Share button does. Download and sharing are separate permissions. */
export function shareMode(plan) {
  if (plan.canShareFile && plan.canDownload) return 'file';
  if (plan.canShareLink) return 'link';
  return 'none';
}
