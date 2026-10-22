import { json, requireUser } from '@/lib/server';
import { getEntitlements } from '@/lib/entitlements';

export const runtime = 'nodejs';

/** What the signed-in person may do. For display only — every action re-checks on the server. */
export async function GET(req) {
  const auth = await requireUser(req);
  if (!auth) return json({ error: 'Not signed in.' }, 401);
  const e = await getEntitlements(auth.supabase, auth.user.id);
  return json({
    plan: e.plan, canDownload: e.canDownload, shareMode: e.shareMode, canShareLink: e.canShareLink, canShareFile: e.canShareFile,
    canUseGuru: e.canUseGuru, cinematicReels: e.cinematicReels, period: e.period, reelsLeft: e.reelsLeft, canGenerateReel: e.canGenerateReel,
    upgradeAvailable: e.upgradeAvailable, renewsAt: e.renewsAt,
    canUseGuruReading: e.canUseGuruReading, canViewAdvancedPatterns: e.canViewAdvancedPatterns,
    guruTextPerDay: e.guruTextPerDay, guruVoicePerDay: e.guruVoicePerDay,
  }, 200);
}
