// Provider layer. The pipeline only talks to these interfaces; every model ID lives here.
//
//   ImageProvider.generate({ prompt, aspect })                → { url, model, cost }
//   ImageProvider.edit({ prompt, imageUrls, aspect })          → { url, model, cost }   (reference-conditioned)
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

// List prices (USD) used for budgeting and cost estimates. Checked 2026-10-16 from fal's
// model pages as quoted by search (fal.ai itself was not reachable from the build sandbox):
//   fal-ai/kling-video/v2.5-turbo/pro/image-to-video  $0.07/s  ($0.35 per 5 s clip)
//   fal-ai/kling-video/o1/reference-to-video          $0.112/s ($0.56 per 5 s clip)
//   fal-ai/nano-banana and /edit                      ~$0.04 per image
// Override any of them without a code change: PRICE_<MODEL_KEY>=number (see README "Costs").
export const PRICES = {
  'fal-ai/nano-banana': Number(process.env.PRICE_NANO_BANANA || 0.04),
  'fal-ai/nano-banana/edit': Number(process.env.PRICE_NANO_BANANA_EDIT || 0.04),
  'fal-ai/kling-video/v2.5-turbo/pro/image-to-video': Number(process.env.PRICE_KLING_25_PER_S || 0.07), // per second
  'fal-ai/kling-video/o1/reference-to-video': Number(process.env.PRICE_KLING_O1_PER_S || 0.112), // per second
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
      return { url, model, cost: PRICES[model] ?? 0.04 };
    },
    async edit({ prompt, imageUrls, aspect = '9:16' }) {
      const r = await client().subscribe(editModel, { input: { prompt, image_urls: imageUrls.slice(0, 8), num_images: 1, aspect_ratio: aspect, output_format: 'jpeg' } });
      const url = r?.data?.images?.[0]?.url;
      if (!url) throw new Error('keyframe provider returned no image');
      return { url, model: editModel, cost: PRICES[editModel] ?? 0.04 };
    },
  };
}

export const VIDEO_ADAPTERS = {
  // Scenic shots: animates our keyframe (first frame). Identity comes from the keyframe.
  'kling-i2v': {
    model: 'fal-ai/kling-video/v2.5-turbo/pro/image-to-video',
    referenceConditioned: false,
    input: ({ startImageUrl, prompt, negative, duration }) => ({
      prompt, image_url: startImageUrl, duration: String(duration >= 10 ? 10 : 5), negative_prompt: negative, cfg_scale: 0.5,
    }),
  },
  // Identity shots: Kling O1 reference-to-video. Each recurring person/object is an
  // "element" (frontal image + extra angles); the keyframe is @Image1, the opening frame.
  // NOTE: field names follow fal's published examples (elements / frontal_image_url /
  // reference_image_urls / image_urls / @ElementN / @ImageN). Validate on the first real run.
  'kling-o1-ref': {
    model: 'fal-ai/kling-video/o1/reference-to-video',
    referenceConditioned: true,
    input: ({ startImageUrl, prompt, duration, elements = [] }) => ({
      prompt: [
        '@Image1 is the opening frame of this shot; start exactly from it.',
        ...elements.map((e, i) => `@Element${i + 1} is ${e.label}; keep their exact appearance throughout.`),
        prompt,
      ].join(' ').slice(0, 2400),
      elements: elements.map((e) => ({ frontal_image_url: e.frontal, reference_image_urls: e.references.slice(0, 3) })),
      image_urls: [startImageUrl],
      duration: String(duration >= 10 ? 10 : 5),
      aspect_ratio: '9:16',
    }),
  },
};

export function videoProvider(kind) {
  const id = VIDEO_ADAPTERS[kind] ? kind : 'kling-i2v';
  const adapter = VIDEO_ADAPTERS[id];
  return {
    id,
    model: adapter.model,
    referenceConditioned: adapter.referenceConditioned,
    costPerSecond: PRICES[adapter.model] ?? 0.12,
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
