import { after } from 'next/server';
import { json, requireUser, getServiceSupabase } from '@/lib/server';
import { runReel, reelPaths, REEL_BUCKET } from '@/lib/reel/pipeline';
import { reelFilename } from '@/lib/brand';
import { logEvent } from '@/lib/analytics-server';
import { getEntitlements, claimCredit } from '@/lib/entitlements';
import { underLimit } from '@/lib/ratelimit';
import { kickWorker, deploymentEnv } from '@/lib/cinema/worker';
import { MEDIA_BUCKET, mediaPath } from '@/lib/cinema/media';
import { requeueProduction, CINEMATIC_FAILED } from '@/lib/cinema/production';

// Rendering continues in the background (after the response) for up to this long.
export const maxDuration = 300;
export const runtime = 'nodejs';

const STALE_MS = 6 * 60 * 1000; // a job silent this long has died; it may be retried
const MAX_ATTEMPTS = 5; // per dream, so retries can't run up costs
const DAILY_LIMIT = Number(process.env.REEL_DAILY_LIMIT || 8);
const LINK_SECONDS = 2 * 60 * 60; // paid: play + download links
const FREE_PLAY_SECONDS = 30 * 60; // free: a short play-only link (watching, not a file to keep)
const STALLED_MS = 60 * 1000; // a production nobody is working on gets nudged by the page's polling

// Real stages only, in the words the page shows (see components/ReelHero.js).
const PUBLIC_STAGES = new Set(['understanding', 'storyboard', 'references', 'keyframes', 'animating', 'voice', 'editing', 'checking']);

function isUuid(id) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id || ''); }
const isStale = (reel) => Date.now() - new Date(reel.updated_at).getTime() > STALE_MS;

async function ownDream(supabase, userId, id) {
  const { data } = await supabase.from('dreams').select('id, user_id, title, status, scenes').eq('id', id).eq('user_id', userId).maybeSingle();
  return data;
}

/** The cinematic production for this dream — read by the SERVER, after the ownership check. */
async function productionFor(userId, id) {
  try {
    const { data, error } = await getServiceSupabase().from('dream_productions')
      .select('dream_id, user_id, env, tier, status, stage, renderer_type, error, updated_at, lock_until, assets, credit_id')
      .eq('dream_id', id).eq('user_id', userId).maybeSingle();
    return error ? null : data;
  } catch { return null; }
}

/** Signed links for a finished film. Download links exist only for plans that include downloads. */
async function describe(supabase, userId, dream, reel, ent, { cinematic }) {
  if (!reel) return { status: 'not_started' };
  if ((reel.status === 'queued' || reel.status === 'processing') && isStale(reel)) {
    return { status: 'failed', error: 'Your reel took too long to finish. Please try again.', canRetry: reel.attempts < MAX_ATTEMPTS };
  }
  const base = { status: reel.status, stage: reel.stage, canRetry: reel.status === 'failed' && reel.attempts < MAX_ATTEMPTS };
  if (reel.status === 'failed') return { ...base, error: reel.error || 'Something went wrong while making your reel.' };
  if (reel.status !== 'completed') return base;

  // Paths are rebuilt from the owner's id — a stored path is never trusted.
  const filename = reelFilename(dream.title);
  const canDownload = Boolean(ent?.canDownload);
  let bucket, videoPath, posterPath;
  if (cinematic) {
    bucket = getServiceSupabase().storage.from(MEDIA_BUCKET); // private, service-only bucket
    videoPath = mediaPath(userId, dream.id, 'reel.mp4');
    posterPath = mediaPath(userId, dream.id, 'reel-poster.jpg');
  } else {
    bucket = supabase.storage.from(REEL_BUCKET);
    const paths = reelPaths(userId, dream.id);
    videoPath = paths.video; posterPath = paths.poster;
  }
  const [play, dl, poster] = await Promise.all([
    bucket.createSignedUrl(videoPath, canDownload ? LINK_SECONDS : FREE_PLAY_SECONDS),
    canDownload ? bucket.createSignedUrl(videoPath, LINK_SECONDS, { download: filename }) : Promise.resolve({ data: null }),
    reel.poster_path ? bucket.createSignedUrl(posterPath, FREE_PLAY_SECONDS) : Promise.resolve({ data: null }),
  ]);
  if (!play.data?.signedUrl) return { status: 'failed', error: "We couldn't find your reel. Please make it again.", canRetry: !cinematic };
  return {
    ...base,
    mode: cinematic ? 'cinematic' : 'legacy',
    videoUrl: play.data.signedUrl,
    downloadUrl: canDownload ? dl.data?.signedUrl || null : null,
    canDownload,
    shareMode: ent?.shareMode || 'link',
    upgradeAvailable: Boolean(ent?.upgradeAvailable),
    rendererType: reel.renderer_type || 'image_fallback',
    posterUrl: poster.data?.signedUrl || null,
    filename,
    duration: reel.duration_seconds,
    completedAt: reel.completed_at,
  };
}

async function report(supabase, user, dream, id, prod) {
  const ent = await getEntitlements(supabase, user.id);
  if (prod && prod.status !== 'completed') {
    if (prod.status === 'failed') {
      const retryable = (prod.assets?.userRetries || 0) < 1 && prod.error === CINEMATIC_FAILED;
      return { status: 'failed', mode: 'cinematic', error: prod.error || CINEMATIC_FAILED, canRetry: retryable };
    }
    // Safety net: if nobody holds it and it hasn't moved for a minute, wake THIS environment's worker.
    const idle = Date.now() - new Date(prod.updated_at).getTime() > STALLED_MS;
    const unlocked = !prod.lock_until || new Date(prod.lock_until).getTime() < Date.now();
    if (idle && unlocked && prod.env === deploymentEnv()) after(() => kickWorker(id));
    return { status: 'processing', mode: 'cinematic', stage: PUBLIC_STAGES.has(prod.stage) ? prod.stage : null, dreamReady: dream.status === 'ready' };
  }
  const { data: reel } = await supabase.from('dream_reels').select('*').eq('dream_id', id).eq('user_id', user.id).maybeSingle();
  return describe(supabase, user.id, dream, reel, ent, { cinematic: Boolean(prod) });
}

export async function GET(req, { params }) {
  const auth = await requireUser(req);
  if (!auth) return json({ error: 'Not signed in.' }, 401);
  const { id } = await params;
  if (!isUuid(id)) return json({ error: 'Not found.' }, 404);
  const dream = await ownDream(auth.supabase, auth.user.id, id);
  if (!dream) return json({ error: 'Not found.' }, 404);
  return json(await report(auth.supabase, auth.user, dream, id, await productionFor(auth.user.id, id)));
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
  // Dreams made by the Dream Director are produced by the worker — never by this older renderer.
  const prod = await productionFor(user.id, id);
  if (prod) {
    const body = await req.json().catch(() => ({}));
    if (body.retry && prod.status === 'failed' && prod.error === CINEMATIC_FAILED && prod.env === deploymentEnv()) {
      // A person's retry: same dream, so the same credit (re-taken if it was given back). Only failed shots redo.
      const ent = await getEntitlements(supabase, user.id);
      const claim = await claimCredit(user.id, id, ent);
      if (!claim.creditId) return json({ status: 'failed', mode: 'cinematic', error: "You don't have a cinematic Dream Reel left for a retry.", canRetry: false, upgrade: ent.plan !== 'premium' }, 402);
      const admin = getServiceSupabase();
      await admin.from('dream_productions').update({ credit_id: claim.creditId }).eq('dream_id', id);
      if (!(await requeueProduction(admin, prod))) return json({ status: 'failed', mode: 'cinematic', error: prod.error, canRetry: false });
      after(() => kickWorker(id));
      return json({ status: 'processing', mode: 'cinematic', stage: null }, 202);
    }
    return json(await report(supabase, user, dream, id, prod));
  }
  if (dream.status !== 'ready' || !dream.scenes?.length) return json({ error: 'This dream is still being painted.' }, 409);
  const ent = await getEntitlements(supabase, user.id);

  const { data: reel, error: readErr } = await supabase.from('dream_reels').select('*').eq('dream_id', id).maybeSingle();
  if (readErr) {
    console.error('dream_reels unavailable', readErr.message);
    return json({ error: 'Reels are not switched on yet.' }, 503);
  }

  // Already finished or already running → just report it (no duplicate work, no extra cost).
  if (reel && (reel.status === 'completed' || ((reel.status === 'queued' || reel.status === 'processing') && !isStale(reel)))) {
    return json(await describe(supabase, user.id, dream, reel, ent, { cinematic: false }));
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
  if ((count || 0) >= DAILY_LIMIT || !(await underLimit(user.id, 'reelRetry'))) {
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
      return json(await describe(supabase, user.id, dream, other, ent, { cinematic: false }));
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
      return json(await describe(supabase, user.id, dream, other, ent, { cinematic: false }));
    }
    claimed = data;
  }

  await logEvent(supabase, user.id, 'reel_render_started', { attempt: claimed.attempts });
  after(() => runReel({ supabase, userId: user.id, dreamId: id }));
  return json({ status: 'queued', stage: null }, 202);
}
