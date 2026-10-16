// Provider layer. The pipeline only talks to these interfaces; the fal.ai
// adapters below are the current implementation and can be swapped per model.
//
//   ImageProvider.generate({ prompt, aspect })                  → { url }
//   ImageProvider.edit({ prompt, imageUrls, aspect })            → { url }     (reference-conditioned)
//   VideoProvider.submit({ startImageUrl, prompt, negative, duration, elements }) → { requestId }
//   VideoProvider.check(requestId) → { status: 'pending'|'done'|'failed', url?, error? }
//
// All long jobs use fal's queue, so a slow model never blocks a server function.
import { fal } from '@fal-ai/client';

let configured = false;
function client() {
  if (!process.env.FAL_KEY) throw new Error('FAL_KEY is not set');
  if (!configured) { fal.config({ credentials: process.env.FAL_KEY }); configured = true; }
  return fal;
}

// Approximate list prices (USD) used only for budgeting; see README "Costs".
export const PRICES = {
  'fal-ai/nano-banana': 0.039,
  'fal-ai/nano-banana/edit': 0.039,
  'fal-ai/kling-video/v2.5-turbo/pro/image-to-video': 0.07, // per second
  'fal-ai/kling-video/o1/reference-to-video': 0.112, // per second
};

export function imageProvider(model = process.env.FAL_REFERENCE_MODEL || 'fal-ai/nano-banana', editModel = process.env.FAL_KEYFRAME_MODEL || 'fal-ai/nano-banana/edit') {
  return {
    id: 'fal-image',
    model,
    editModel,
    async generate({ prompt, aspect = '9:16' }) {
      const r = await client().subscribe(model, { input: { prompt, num_images: 1, aspect_ratio: aspect, output_format: 'jpeg' } });
      const url = r?.data?.images?.[0]?.url;
      if (!url) throw new Error('image provider returned no image');
      return { url, model, cost: PRICES[model] || 0 };
    },
    async edit({ prompt, imageUrls, aspect = '9:16' }) {
      const r = await client().subscribe(editModel, { input: { prompt, image_urls: imageUrls.slice(0, 8), num_images: 1, aspect_ratio: aspect, output_format: 'jpeg' } });
      const url = r?.data?.images?.[0]?.url;
      if (!url) throw new Error('keyframe provider returned no image');
      return { url, model: editModel, cost: PRICES[editModel] || 0 };
    },
  };
}

const VIDEO_ADAPTERS = {
  // Animates our consistent keyframe (first frame). Identity comes from the keyframe.
  'kling-i2v': {
    model: 'fal-ai/kling-video/v2.5-turbo/pro/image-to-video',
    input: ({ startImageUrl, prompt, negative, duration }) => ({
      prompt, image_url: startImageUrl, duration: String(duration >= 10 ? 10 : 5), negative_prompt: negative, cfg_scale: 0.5,
    }),
  },
  // Kling O1: identity "elements" (frontal + extra angles) per character, plus the keyframe as a style/first-frame image.
  'kling-o1-ref': {
    model: 'fal-ai/kling-video/o1/reference-to-video',
    input: ({ startImageUrl, prompt, duration, elementImages = [] }) => ({
      prompt: `${elementImages.map((_, i) => `@Element${i + 1}`).join(' ')} ${prompt} Match the composition of @Image1.`.trim(),
      elements: elementImages.map((url) => ({ frontal_image_url: url, reference_image_urls: [url] })),
      image_urls: [startImageUrl],
      duration: String(duration >= 10 ? 10 : 5),
      aspect_ratio: '9:16',
    }),
  },
};

export function videoProvider(kind = process.env.VIDEO_PROVIDER || 'kling-i2v') {
  const adapter = VIDEO_ADAPTERS[kind] || VIDEO_ADAPTERS['kling-i2v'];
  return {
    id: kind,
    model: adapter.model,
    costPerSecond: PRICES[adapter.model] || 0.1,
    async submit(req) {
      const { request_id } = await client().queue.submit(adapter.model, { input: adapter.input(req) });
      return { requestId: request_id };
    },
    async check(requestId) {
      try {
        const st = await client().queue.status(adapter.model, { requestId });
        if (st.status !== 'COMPLETED') return { status: 'pending' };
        const r = await client().queue.result(adapter.model, { requestId });
        const url = r?.data?.video?.url;
        return url ? { status: 'done', url } : { status: 'failed', error: 'no video in result' };
      } catch (e) {
        return { status: 'failed', error: String(e?.message || e).slice(0, 200) };
      }
    },
  };
}
