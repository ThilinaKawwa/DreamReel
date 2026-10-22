import OpenAI from 'openai';
import { STYLES, DEFAULT_STYLE } from '@/lib/styles';
import { json, requireUser } from '@/lib/server';
import { logEvent } from '@/lib/analytics-server';
import { getEntitlements } from '@/lib/entitlements';
import { underLimit } from '@/lib/ratelimit';
import { transcriptionProvider } from '@/lib/audio/transcription';
import { cinematicReady, startCinematic } from '@/lib/cinema/start';
import { paintPictures } from '@/lib/reel/pictures';

// Let this function run for up to 60 seconds (painting 5 pictures takes ~15–30s).
export const maxDuration = 60;
export const runtime = 'nodejs';

export async function POST(req) {
  // 1. Who is asking? (the browser sends the login token)
  const auth = await requireUser(req);
  if (!auth) return json({ error: 'Not signed in.' }, 401);
  const { user, supabase } = auth;

  if (!process.env.OPENAI_API_KEY || !process.env.FAL_KEY) {
    return json({ error: 'The app is missing its OPENAI_API_KEY or FAL_KEY. Add them in Vercel → Settings → Environment Variables.' }, 500);
  }

  // 2. What may this person do? Decided here from trusted data — never from the browser.
  const ent = await getEntitlements(supabase, user.id);
  const premium = ent.plan === 'premium';
  const cinematic = await cinematicReady();
  if (cinematic && ent.reelsLeft === 0) {
    return json({
      error: premium
        ? "You've used this month's cinematic Dream Reels. They refresh at the start of next month."
        : "You've used your free Dream Reel. Premium makes more of them.",
      upgrade: !premium && ent.upgradeAvailable, limit: true,
    }, 402);
  }
  if (!(await underLimit(user.id, 'dream'))) return json({ error: 'Too many dreams in a short time. Please wait a little.' }, 429);
  if (!cinematic) {
    // Cinematic films not configured on this deployment: the older picture flow with its rolling cap.
    const limit = Number(premium ? process.env.PREMIUM_DAILY_LIMIT || 5 : process.env.DAILY_LIMIT || 3);
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count } = await supabase.from('dreams').select('id', { count: 'exact', head: true }).eq('user_id', user.id).gte('created_at', since);
    if ((count || 0) >= limit) return json({ error: `You've made ${limit} dreams today. Come back tomorrow morning.` }, 429);
  }

  // 3. Read what was sent: either an audio file or typed text
  const form = await req.formData();
  const audio = form.get('audio');
  const typed = (form.get('text') || '').toString().trim();
  const styleKey = STYLES[form.get('style')] ? form.get('style') : DEFAULT_STYLE;

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // 4. Turn the voice note into text
  let transcript = typed;
  if (!transcript && audio && typeof audio === 'object' && audio.size > 0) {
    try {
      const result = await transcriptionProvider(openai).transcribe(audio, { prompt: 'A person describing a dream they had last night.' });
      transcript = result.text;
    } catch (e) {
      console.error('transcription failed', e);
      return json({ error: "Couldn't hear that clearly. Try again, or type your dream instead." }, 400);
    }
  }
  if (!transcript || transcript.length < 8) {
    return json({ error: "That was a bit short — tell me a little more about the dream." }, 400);
  }

  // 5. Save a "pending" dream so it shows up in the library straight away
  const { data: dream, error: insErr } = await supabase
    .from('dreams')
    .insert({ user_id: user.id, transcript, style: styleKey, status: 'pending', is_public: false }) // private until they share
    .select()
    .single();
  if (insErr) {
    console.error(insErr);
    return json({ error: 'Could not save the dream. Please try again.' }, 500);
  }

  const t0 = Date.now();
  await logEvent(supabase, user.id, 'dream_generation_started', { typed: !audio || !audio.size });

  // 6. Dream Director: take this dream's credit atomically (in the database), then start the
  //    production in THIS deployment's environment. It runs in the background with real stages.
  if (cinematic) {
    const started = await startCinematic({ userId: user.id, dreamId: dream.id, ent });
    if (started.ok) return json({ id: dream.id, mode: 'cinematic' });
    await supabase.from('dreams').delete().eq('id', dream.id);
    if (started.reason === 'no_credits') {
      return json({ error: premium ? "You've used this month's cinematic Dream Reels." : "You've used your free Dream Reel.", upgrade: !premium && ent.upgradeAvailable, limit: true }, 402);
    }
    return json({ error: 'Could not start your dream just now. Please try again.' }, 503);
  }

  // Not configured for cinematic films: the original picture renderer (labelled image_fallback).
  try {
    // 6–8. Scenes, pictures and (premium) moving clips — lib/reel/pictures.js
    const { title, scenes: built, videoStatus } = await paintPictures({ openai, supabase, userId: user.id, dreamId: dream.id, transcript, styleKey, premium });

    // Only premium dreams touch video_status, so free dreams keep working even
    // before the Premium database update has been run.
    const update = { title, scenes: built, status: 'ready' };
    if (videoStatus) update.video_status = videoStatus;
    const { error: updErr } = await supabase.from('dreams').update(update).eq('id', dream.id);
    if (updErr) throw updErr;

    await logEvent(supabase, user.id, 'dream_generation_completed', { ms: Date.now() - t0, scenes: built.length });
    return json({ id: dream.id, mode: 'image_fallback' });
  } catch (e) {
    console.error('dream failed', e);
    await supabase.from('dreams').update({ status: 'failed', error: String(e?.message || e).slice(0, 500) }).eq('id', dream.id);
    await logEvent(supabase, user.id, 'dream_generation_failed', { ms: Date.now() - t0 });
    return json({ error: 'Something went wrong while painting. Please try once more.' }, 500);
  }
}
