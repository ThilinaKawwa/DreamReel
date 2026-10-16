// Cost model for a cinematic Dream Reel. Pure — used for budget reservation, the
// per-reel cost record and the pricing table in the README. Prices: lib/providers PRICES.
export const UNIT = {
  image: 0.04,            // nano-banana / nano-banana edit, per image
  scenicPerSecond: 0.07,  // Kling 2.5 Turbo Pro i2v
  identityPerSecond: 0.112, // Kling O1 reference-to-video
  shotSeconds: 5,
  llmDirector: 0.03,      // DreamBible + storyboard (gpt-4.1, ~6k tokens in / 2.5k out in total)
  ttsPerLine: 0.002,      // gpt-4o-mini-tts, ~4 s per line
  transcribe: 0.003,      // gpt-4o-mini-transcribe, ~1 min of speech
};

/**
 * @param {object} p
 * @param {number} p.shots          shots in the film
 * @param {number} p.identityShots  shots routed to the reference-conditioned model
 * @param {number} p.references     reference images (fronts + three-quarters + places + objects)
 * @param {number} [p.failedShots]  shots that needed one retry
 * @param {number} [p.failedImages] images that needed one retry
 */
export function estimateReel({ shots, identityShots, references, failedShots = 0, failedImages = 0 }, u = UNIT) {
  const scenic = shots - identityShots;
  const video = (scenic * u.scenicPerSecond + identityShots * u.identityPerSecond) * u.shotSeconds;
  const retryVideo = failedShots * u.identityPerSecond * u.shotSeconds; // pessimistic: retries priced as identity shots
  const parts = {
    llm: u.llmDirector + u.transcribe,
    references: references * u.image,
    keyframes: shots * u.image,
    video,
    tts: shots * u.ttsPerLine,
    retries: retryVideo + failedImages * u.image,
  };
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  return { parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, round(v)])), total: round(total) };
}

/** What to reserve from the daily budget before starting (assumes every shot is an identity shot). */
export function reservationFor(maxShots) {
  return estimateReel({ shots: maxShots, identityShots: maxShots, references: Math.min(8, maxShots + 3) }).total;
}

const round = (x) => Math.round(x * 1000) / 1000;
