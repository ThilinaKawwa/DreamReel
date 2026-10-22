// The original picture renderer (labelled image_fallback): 5 scenes, one painted picture each.
// Used when cinematic films aren't configured on a deployment — by /api/dreams (record a reel)
// and by /api/dreams/[id]/visualize (turn a saved Guru dream into a reel).
import { fal } from '@fal-ai/client';
import { STYLES, DEFAULT_STYLE } from '@/lib/styles';
import { storeBytes } from '@/lib/server';
import { submitAnimation, FREE_IMAGE_MODEL, PREMIUM_IMAGE_MODEL } from '@/lib/video';

const SCENE_COUNT = 5;

/** Writes the scenes and paints them. Returns { title, scenes, videoStatus } — the caller saves them. */
export async function paintPictures({ openai, supabase, userId, dreamId, transcript, styleKey, premium }) {
  const scenes = await writeScenes(openai, transcript);
  // Paint one picture per scene (all at the same time) and store them.
  // The narrated film is made afterwards by /api/dreams/[id]/reel.
  fal.config({ credentials: process.env.FAL_KEY });
  const suffix = (STYLES[styleKey] || STYLES[DEFAULT_STYLE]).suffix;
  const imageModel = premium ? PREMIUM_IMAGE_MODEL : FREE_IMAGE_MODEL;
  let built = await Promise.all(
    scenes.scenes.map(async (scene, i) => {
      const url = await paintScene(imageModel, `${scene.image_prompt}, ${suffix}`);
      const imageUrl = await storeImage(supabase, userId, dreamId, i, url);
      return { caption: scene.caption, image_prompt: scene.image_prompt, motion: scene.motion, image_url: imageUrl };
    })
  );
  // Premium: queue a moving clip for every scene (collected later by the reel page)
  let videoStatus = null;
  if (premium) {
    built = await submitAnimation(built);
    videoStatus = built.some((s) => s.video_request_id) ? 'animating' : 'failed';
  }
  return { title: scenes.title, scenes: built, videoStatus };
}

export async function writeScenes(openai, transcript) {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.8,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You turn a person's spoken description of a dream into a short visual story of exactly ${SCENE_COUNT} scenes.
Return JSON: {"title": string, "scenes": [{"caption": string, "image_prompt": string, "motion": string}]}.
- title: 2–5 words, poetic, no full stop.
- caption: one or two short sentences (max 22 words) in first person, past tense, as if softly narrating the dream aloud. Keep the dreamer's own details and mood. Captions are read aloud one after another, so together they should flow as one story.
- image_prompt: a vivid visual description for an image generator (max 45 words). Describe the setting, subject, composition, light and colour. Vertical portrait framing. No people's real names. No text in the image. Do not mention the word "dream".
- motion: what should gently move if this picture came to life (max 18 words), e.g. "waves of starlight roll in, the moon shimmers, camera slowly pushes forward".
- The last scene should feel like waking or an ending.
- Keep it gentle and safe for all ages, even if the dream was scary: show mood, not gore.`,
      },
      { role: 'user', content: transcript },
    ],
  });
  const parsed = JSON.parse(completion.choices[0].message.content || '{}');
  if (!Array.isArray(parsed.scenes) || parsed.scenes.length === 0) throw new Error('No scenes returned');
  parsed.scenes = parsed.scenes.slice(0, SCENE_COUNT);
  parsed.title = parsed.title || 'Last night';
  return parsed;
}

export async function paintScene(model, prompt) {
  const input = { prompt, image_size: 'portrait_16_9', num_images: 1, enable_safety_checker: true };
  if (model.includes('schnell')) input.num_inference_steps = 4;
  const result = await fal.subscribe(model, { input });
  const url = result?.data?.images?.[0]?.url;
  if (!url) throw new Error('No image returned');
  return url;
}

/** Copies the painted image into our own storage so it never expires. */
export async function storeImage(supabase, userId, dreamId, index, sourceUrl) {
  const res = await fetch(sourceUrl);
  if (!res.ok) throw new Error('Could not download image');
  const bytes = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') || 'image/jpeg';
  const ext = contentType.includes('png') ? 'png' : 'jpg';
  const path = `${userId}/${dreamId}/${index}.${ext}`;
  try {
    return await storeBytes(supabase, path, bytes, contentType);
  } catch (error) {
    // If storage fails, fall back to the original URL rather than losing the dream.
    console.error('storage upload failed', error);
    return sourceUrl;
  }
}
