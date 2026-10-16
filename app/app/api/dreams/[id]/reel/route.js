import { after } from 'next/server';
import { json, requireUser } from '@/lib/server';
import { runReel, reelPaths, REEL_BUCKET } from '@/lib/reel/pipeline';
import { reelFilename } from '@/lib/brand';
import { logEvent } from '@/lib/analytics-server';

// Rendering continues in the background (after the response) for up to this long.
export const maxDuration = 300;
export const runtime = 'nodejs';

const STALE_MS = 6 * 60 * 1000; // a job silent this long has died; it may be retried
const MAX_ATTEMPTS = 5; // per dream, so retries can't run up costs
const DAILY_LIMIT = Number(process.env.REEL_DAILY_LIMIT || 8);
const LINK_SECONDS = 2 * 60 * 60;

function isUuid(id) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id || ''); }
const isStale = (reel) => Date.now() - new Date(reel.updated_at).getTime() > STALE_MS;

async function ownDream(supabase, userId, id) {
  const { data } = await supabase.from('dreams').select('id, user_id, title, status, scenes').eq('id', id).eq('user_id', userId).maybeSingle();
  return data;
}

/** What the page needs to know: status, real stage, and signed links once finished. */
async function describe(supabase, userId, dream, reel) {
  if (!reel) return { status: 'not_started' };
  if ((reel.status === 'queued' || reel.status === 'processing') && isStale(reel)) {
    return { status: 'failed', error: 'Your reel took too long to finish. Please try again.', canRetry: reel.attempts < MAX_ATTEMPTS };
  }
  const base = { status: reel.status, stage: reel.stage, canRetry: reel.status === 'failed' && reel.attempts < MAX_ATTEMPTS };
  if (reel.status === 'failed') return { ...base, error: reel.error || 'Something went wrong while making your reel.' };
  if (reel.status !== 'completed') return base;

  // Paths are rebuilt from the owner's id — a stored path is never trusted.
  const paths = reelPaths(userId, dream.id);
  const filename = reelFilename(dream.title);
  const bucket = supabase.storage.from(REEL_BUCKET);
  const [play, dl, poster] = await Promise.all([
    bucket.createSignedUrl(paths.video, LINK_SECONDS),
    bucket.createSignedUrl(paths.video, LINK_SECONDS, { download: filename }),
    reel.poster_path ? bucket.createSignedUrl(paths.poster, LINK_SECONDS) : Promise.resolve({ data: null }),
  ]);
  if (!play.data?.signedUrl) return { status: 'failed', error: "We couldn't find your reel. Please make it again.", canRetry: true };
  return {
    ...base,
    videoUrl: play.data.signedUrl,
    downloadUrl: dl.data?.signedUrl || play.data.signedUrl,
    posterUrl: poster.data?.signedUrl || null,
    filename,
    duration: reel.duration_seconds,
    soundtrack: reel.soundtrack,
    completedAt: reel.completed_at,
  };
}

export async function GET(req, { params }) {
  const auth = await requireUser(req);
  if (!auth) return json({ error: 'Not signed in.' }, 401);
  const { id } = await params;
  if (!isUuid(id)) return json({ error: 'Not found.' }, 404);
  const dream = await ownDream(auth.supabase, auth.user.id, id);
  if (!dream) return json({ error: 'Not found.' }, 404);
  const { data: reel } = await auth.supabase.from('dream_reels').select('*').eq('dream_id', id).eq('user_id', auth.user.id).maybeSingle();
  return json(await describe(auth.supabase, auth.user.id, dream, reel));
}

/** Starts (or retries) making the film. Safe to call twice: only one job runs per dream. */
export async function POST(req, { params }) {
  const auth = await requireUser(req);
  if (!auth) return json({ error: 'Not signed in.' }, 401);
  const { supabase, user } = auth;
  const { id } = await params;
  if (!isUuid(id)) return json({ error: 'Not found.' }, 404);
  const dream = await ownDream(supabase, user.id, id);
  if (!dream) return json({ error: 'Not found.' }, 404);
  if (dream.status !== 'ready' || !dream.scenes?.length) return json({ error: 'This dream is still being painted.' }, 409);

  const { data: reel, error: readErr } = await supabase.from('dream_reels').select('*').eq('dream_id', id).maybeSingle();
  if (readErr) {
    console.error('dream_reels unavailable', readErr.message);
    return json({ error: 'Reels are not switched on yet.' }, 503);
  }

  // Already finished or already running → just report it (no duplicate work, no extra cost).
  if (reel && (reel.status === 'completed' || ((reel.status === 'queued' || reel.status === 'processing') && !isStale(reel)))) {
    return json(await describe(supabase, user.id, dream, reel));
  }
  if (reel && reel.attempts >= MAX_ATTEMPTS) {
    return json({ status: 'failed', error: "This reel couldn't be made after several tries. We're looking into it.", canRetry: false });
  }

  // Fair-use cap per person per day. Counted from the render-start log, which people can
  // add to but never edit or delete — so the cap can't be dodged by editing their own rows.
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count, error: countErr } = await supabase.from('analytics_events').select('id', { count: 'exact', head: true })
    .eq('user_id', user.id).eq('event', 'reel_render_started').gte('created_at', since);
  if (countErr) console.error('render cap check failed', countErr.message);
  if ((count || 0) >= DAILY_LIMIT) {
    return json({ status: 'failed', error: `You've made ${DAILY_LIMIT} reels today. Come back tomorrow.`, canRetry: false }, 429);
  }

  // Claim the job atomically so two taps can't start two renders.
  const now = new Date().toISOString();
  let claimed;
  if (!reel) {
    const { data, error } = await supabase.from('dream_reels')
      .insert({ dream_id: id, user_id: user.id, status: 'queued', attempts: 1, started_at: now, updated_at: now })
      .select().maybeSingle();
    if (error) {
      // Someone else inserted first — report their job.
      const { data: other } = await supabase.from('dream_reels').select('*').eq('dream_id', id).maybeSingle();
      return json(await describe(supabase, user.id, dream, other));
    }
    claimed = data;
  } else {
    const staleBefore = new Date(Date.now() - STALE_MS).toISOString();
    const { data } = await supabase.from('dream_reels')
      .update({ status: 'queued', stage: null, error: null, attempts: reel.attempts + 1, started_at: now, updated_at: now })
      .eq('dream_id', id).eq('updated_at', reel.updated_at)
      .or(`status.eq.failed,updated_at.lt.${staleBefore}`)
      .select().maybeSingle();
    if (!data) {
      const { data: other } = await supabase.from('dream_reels').select('*').eq('dream_id', id).maybeSingle();
      return json(await describe(supabase, user.id, dream, other));
    }
    claimed = data;
  }

  await logEvent(supabase, user.id, 'reel_render_started', { attempt: claimed.attempts });
  after(() => runReel({ supabase, userId: user.id, dreamId: id }));
  return json({ status: 'queued', stage: null }, 202);
}
