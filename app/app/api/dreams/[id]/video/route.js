import { json, requireUser, getProfile, isPremium } from '@/lib/server';
import { submitAnimation, collectAnimation } from '@/lib/video';

export const maxDuration = 60;
export const runtime = 'nodejs';

async function loadOwnDream(supabase, userId, id) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data } = await supabase.from('dreams').select('*').eq('id', id).eq('user_id', userId).maybeSingle();
  return data;
}

/** Checks on the moving clips. The reel page calls this every few seconds while animating. */
export async function GET(req, { params }) {
  const auth = await requireUser(req);
  if (!auth) return json({ error: 'Not signed in.' }, 401);
  const { id } = await params;
  const dream = await loadOwnDream(auth.supabase, auth.user.id, id);
  if (!dream) return json({ error: 'Not found.' }, 404);
  if (dream.video_status !== 'animating') return json({ video_status: dream.video_status, scenes: dream.scenes });

  const { scenes, changed, status } = await collectAnimation(auth.supabase, dream);
  if (changed || status !== dream.video_status) {
    await auth.supabase.from('dreams').update({ scenes, video_status: status }).eq('id', id);
  }
  return json({ video_status: status, scenes });
}

/** Premium: bring an older (still-picture) dream to life. */
export async function POST(req, { params }) {
  const auth = await requireUser(req);
  if (!auth) return json({ error: 'Not signed in.' }, 401);
  if (!isPremium(await getProfile(auth.supabase, auth.user.id))) {
    return json({ error: 'Moving reels are part of Premium.', upgrade: true }, 402);
  }
  const { id } = await params;
  const dream = await loadOwnDream(auth.supabase, auth.user.id, id);
  if (!dream || dream.status !== 'ready') return json({ error: 'Not found.' }, 404);
  if (dream.video_status === 'animating' || dream.video_status === 'ready') {
    return json({ video_status: dream.video_status, scenes: dream.scenes });
  }

  // Clear earlier failures so they can be retried.
  const fresh = (dream.scenes || []).map(({ video_failed, video_request_id, video_model, ...s }) => s);
  const scenes = await submitAnimation(fresh);
  const status = scenes.some((s) => s.video_request_id) ? 'animating' : 'failed';
  await auth.supabase.from('dreams').update({ scenes, video_status: status }).eq('id', id);
  return json({ video_status: status, scenes });
}
