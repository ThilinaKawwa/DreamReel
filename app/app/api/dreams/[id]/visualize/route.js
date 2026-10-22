import OpenAI from 'openai';
import { json, requireUser, getServiceSupabase } from '@/lib/server';
import { logEvent } from '@/lib/analytics-server';
import { getEntitlements } from '@/lib/entitlements';
import { underLimit } from '@/lib/ratelimit';
import { cinematicReady, startCinematic } from '@/lib/cinema/start';
import { paintPictures } from '@/lib/reel/pictures';

// The picture fallback paints 5 images inside this request (~15–30 s).
export const maxDuration = 60;
export const runtime = 'nodejs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * "Would you like me to visualize this dream?" → yes.
 * Turns an already-saved dream into a Dream Reel through the EXISTING pipeline: the Dream
 * Director when cinematic films are configured, the picture renderer otherwise. The same
 * dream row is used — never a copy — and a failure never touches the saved dream.
 */
export async function POST(req, { params }) {
  const auth = await requireUser(req);
  if (!auth) return json({ error: 'Not signed in.' }, 401);
  const { user, supabase } = auth;
  const { id } = await params;
  if (!UUID.test(id || '')) return json({ error: 'Not found.' }, 404);
  const { data: dream } = await supabase.from('dreams').select('id, user_id, transcript, title, style, status, scenes')
    .eq('id', id).eq('user_id', user.id).maybeSingle();
  if (!dream) return json({ error: 'Not found.' }, 404);
  await logEvent(supabase, user.id, 'visualize_dream_clicked', {});

  if ((dream.scenes || []).length || dream.status === 'pending') return json({ status: 'exists' });
  if (String(dream.transcript || '').trim().split(/\s+/).length < 8) return json({ error: 'Tell Orin a little more about this dream first.' }, 400);
  try {
    const { data: prod } = await getServiceSupabase().from('dream_productions').select('status').eq('dream_id', id).eq('user_id', user.id).maybeSingle();
    if (prod && prod.status !== 'failed') return json({ status: 'exists' });
  } catch {}
  if (!(await underLimit(user.id, 'dream'))) return json({ error: 'Too many in a short time. Please wait a little.' }, 429);

  const ent = await getEntitlements(supabase, user.id);
  const premium = ent.plan === 'premium';
  await logEvent(supabase, user.id, 'dream_generation_started', { typed: false, from: 'guru' });

  if (await cinematicReady()) {
    if (ent.reelsLeft === 0) {
      return json({
        error: premium ? "You've used this month's Dream Reels. They refresh at the start of next month." : "You've used your free Dream Reel. Premium makes more of them.",
        upgrade: !premium && ent.upgradeAvailable, limit: true,
      }, 402);
    }
    const started = await startCinematic({ userId: user.id, dreamId: id, ent });
    if (started.ok) return json({ status: 'started', mode: 'cinematic' }, 202);
    if (started.reason === 'no_credits') return json({ error: "You don't have a Dream Reel left right now.", upgrade: !premium && ent.upgradeAvailable, limit: true }, 402);
    return json({ error: 'Could not start your Dream Reel just now. Your dream is still saved.' }, 503);
  }

  // Cinematic films aren't configured on this deployment: the original picture renderer.
  if (!process.env.FAL_KEY || !process.env.OPENAI_API_KEY) return json({ error: 'Dream Reels are not switched on yet. Your dream is saved.' }, 503);
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const { title, scenes, videoStatus } = await paintPictures({ openai, supabase, userId: user.id, dreamId: id, transcript: dream.transcript, styleKey: dream.style, premium });
    const update = { scenes, status: 'ready', updated_at: new Date().toISOString() };
    if (!dream.title) update.title = title;          // keep the title they already know
    if (videoStatus) update.video_status = videoStatus;
    const { error } = await supabase.from('dreams').update(update).eq('id', id).eq('user_id', user.id);
    if (error) throw error;
    await logEvent(supabase, user.id, 'dream_generation_completed', { scenes: scenes.length, from: 'guru' });
    return json({ status: 'started', mode: 'image_fallback' });
  } catch (e) {
    console.error('visualize failed', e?.message || e);
    await logEvent(supabase, user.id, 'dream_generation_failed', { from: 'guru' });
    return json({ error: 'Something went wrong while painting. Your dream is still saved — try again in a moment.' }, 500);
  }
}
