// Provider layer. The pipeline only talks to these interfaces; every model ID lives here.
//
//   ImageProvider.generate({ prompt, aspect })                → { url, model, cost }
//   ImageProvider.edit({ prompt, imageUrls, aspect })          → { url, model, cost }   (reference-conditioned)
//   VideoProvider.submit({ startImageUrl, prompt, negative, duration, elements }) → { requestId }
//   VideoProvider.check(requestId) → { status: 'pending'|'done'|'failed', url?, error? }
//
// All long jobs use fal's queue, so a slow model never blocks a server function.
import { fal } from '@fal-ai/client';
import { replicateVideoProvider } from './replicate.js';

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
  // Identity shots: Kling O1 Reference image-to-video (fal schema confirmed 2026-10-16):
  //   image_urls: [start frame]          → referenced in the prompt as @Image1
  //   elements: [{ frontal_image_url, reference_image_urls[] }] → @Element1, @Element2 …
  //   each element: frontal_image_url (required) + reference_image_urls (1–3)
  //   at most 7 inputs: start image + elements + any extra top-level images
  //   duration "5", aspect_ratio "9:16"
  'kling-o1-ref': {
    model: 'fal-ai/kling-video/o1/reference-to-video',
    referenceConditioned: true,
    input: (req) => o1Input(req),
  },
};

export const O1_MAX_INPUTS = 7;          // start image(s) + elements + top-level images (fal docs)
export const O1_MAX_ELEMENT_REFERENCES = 3; // reference_image_urls per element: 1–3

/** An element is valid only with a frontal image AND 1–3 additional reference images. Pure. */
export function validO1Element(e) {
  return Boolean(e && e.frontal && Array.isArray(e.references) && e.references.filter(Boolean).length >= 1);
}

/**
 * Inputs as fal counts them: each top-level image (start frame + any image_urls) and each
 * element counts ONE — an element's own frontal/reference images do not count separately.
 */
export function o1InputCount(body) {
  return (body.image_urls?.length || 0) + (body.elements?.length || 0);
}

/**
 * Builds the Kling O1 Reference request. Pure (tested in test/audio-o1.test.mjs).
 * - Elements without a valid reference pack are never sent (no empty reference arrays).
 * - Each element keeps at most 3 additional references.
 * - If start image + elements would exceed 7, the LAST (lowest-priority) elements are dropped;
 *   callers pass elements in priority order (recurring people first, then objects).
 */
export function o1Input({ startImageUrl, prompt, duration, elements = [] }) {
  const maxElements = O1_MAX_INPUTS - 1;
  const els = elements
    .map((e) => e && { ...e, references: (e.references || []).filter(Boolean).slice(0, O1_MAX_ELEMENT_REFERENCES) })
    .filter(validO1Element)
    .slice(0, maxElements);
  return {
    prompt: [
      '@Image1 is the opening frame of this shot; start exactly from it.',
      ...els.map((e, i) => `@Element${i + 1} is ${e.label}; keep their exact appearance throughout.`),
      prompt,
    ].join(' ').slice(0, 2400),
    image_urls: [startImageUrl],
    elements: els.map((e) => ({ frontal_image_url: e.frontal, reference_image_urls: e.references })),
    duration: String(duration >= 10 ? 10 : 5),
    aspect_ratio: '9:16',
  };
}

export function videoProvider(kind) {
  if (kind === 'replicate-kling-i2v') return replicateVideoProvider();
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
