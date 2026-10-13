// Premium: turns each painted scene into a short moving clip with an
// image-to-video model on fal.ai. Jobs run in fal's queue (they take 1–3
// minutes), so we submit them while the dream is made and collect the
// finished clips later from /api/dreams/[id]/video.
import { fal } from '@fal-ai/client';
import { storeFromUrl } from '@/lib/server';

export const VIDEO_MODEL = process.env.FAL_VIDEO_MODEL || 'fal-ai/kling-video/v2.1/standard/image-to-video';
export const FREE_IMAGE_MODEL = process.env.FAL_IMAGE_MODEL || 'fal-ai/flux/schnell';
export const PREMIUM_IMAGE_MODEL = process.env.FAL_IMAGE_MODEL_PREMIUM || 'fal-ai/flux-pro/v1.1';

let configured = false;
function client() {
  if (!configured) { fal.config({ credentials: process.env.FAL_KEY }); configured = true; }
  return fal;
}

function videoInput(model, scene) {
  // Newer Kling endpoints (v2.6, v3) name the picture `start_image_url`; older ones `image_url`.
  const imageKey = /\/(v2\.6|v3)\//.test(model) ? 'start_image_url' : 'image_url';
  return {
    prompt: `${scene.motion || 'slow, gentle dreamlike camera drift, soft natural motion'}. Dreamlike, cinematic, smooth and calm. ${scene.image_prompt}`.slice(0, 900),
    [imageKey]: scene.image_url,
    duration: '5',
    aspect_ratio: '9:16',
    negative_prompt: 'text, watermark, subtitles, blur, flicker, distorted faces, extra limbs, jitter, fast cuts',
  };
}

/** Queues one clip per scene. Returns scenes with video_request_id set. */
export async function submitAnimation(scenes) {
  const f = client();
  return Promise.all(
    scenes.map(async (scene) => {
      if (scene.video_url || scene.video_request_id) return scene;
      try {
        const { request_id } = await f.queue.submit(VIDEO_MODEL, { input: videoInput(VIDEO_MODEL, scene) });
        return { ...scene, video_request_id: request_id, video_model: VIDEO_MODEL };
      } catch (e) {
        console.error('video submit failed', e);
        return { ...scene, video_failed: true };
      }
    })
  );
}

/**
 * Checks the queue for every unfinished clip; finished clips are copied into
 * our storage. Returns { scenes, changed, status } where status is the
 * dream's overall video_status.
 */
export async function collectAnimation(supabase, dream) {
  const f = client();
  let changed = false;
  const scenes = await Promise.all(
    (dream.scenes || []).map(async (scene, i) => {
      if (scene.video_url || scene.video_failed || !scene.video_request_id) return scene;
      const model = scene.video_model || VIDEO_MODEL;
      try {
        const status = await f.queue.status(model, { requestId: scene.video_request_id });
        if (status.status !== 'COMPLETED') return scene;
        const result = await f.queue.result(model, { requestId: scene.video_request_id });
        const src = result?.data?.video?.url;
        if (!src) throw new Error('No video in result');
        const url = await storeFromUrl(supabase, `${dream.user_id}/${dream.id}/v${i}.mp4`, src, 'video/mp4');
        changed = true;
        return { ...scene, video_url: url };
      } catch (e) {
        console.error('video collect failed', i, e?.message || e);
        changed = true;
        return { ...scene, video_failed: true };
      }
    })
  );
  const pending = scenes.some((s) => s.video_request_id && !s.video_url && !s.video_failed);
  const any = scenes.some((s) => s.video_url);
  const status = pending ? 'animating' : any ? 'ready' : 'failed';
  return { scenes, changed, status };
}
