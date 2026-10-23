// Cost model for a cinematic Dream Reel. Pure — used for budget reservation, the per-reel
// cost record (with a usage line per provider call) and the pricing table in the README.
//
// PRICE SOURCES (list prices, checked 2026-10-16; fal.ai and openai.com could not be opened
// directly from the build sandbox, so these come from search results quoting the providers):
//   fal  Kling 2.5 Turbo Pro i2v ............ $0.07 / second        (fal model page)
//   fal  Kling O1 reference-to-video ........ $0.112 / second       (fal model page)
//   fal  nano-banana, nano-banana/edit ...... ~$0.04 / image        (fal-sourced price trackers)
//   OpenAI gpt-transcribe ................... $0.0045 / audio minute (OpenAI pricing via secondary sources)
//   OpenAI gpt-realtime-2.1-mini audio out .. $20 / 1M audio tokens (OpenAI model page via search)
//        → ESTIMATE ~$0.024 / spoken minute, ASSUMING ~1,200 audio tokens per minute (not verified)
//   OpenAI gpt-4.1 (director) ............... ESTIMATE ~$0.015 per call (≈3k tokens in / 1.2k out;
//                                              per-token price not re-verified this session)
// Every unit can be overridden with PRICE_* environment variables.
const num = (v, d) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

export function units(env = process.env) {
  return {
    image: num(env.PRICE_NANO_BANANA, 0.04),
    scenicPerSecond: num(env.PRICE_KLING_25_PER_S, 0.07),
    identityPerSecond: num(env.PRICE_KLING_O1_PER_S, 0.112),
    shotSeconds: 5,
    directorCall: num(env.PRICE_DIRECTOR_CALL, 0.015),
    transcribePerMinute: num(env.PRICE_TRANSCRIBE_PER_MIN, 0.0045),
    ttsPerMinute: num(env.PRICE_TTS_PER_MIN, 0.024),
    ttsSecondsPerLine: 4,
  };
}
export const UNIT = units();

/** One line of the admin cost report. */
export function usageLine({ part, provider, model, unit, quantity, unitPrice, extra }) {
  return { part, provider, model, unit, quantity: round(quantity), unit_price_usd: unitPrice, usd: round(quantity * unitPrice), ...(extra || {}) };
}

/**
 * @param {object} p
 * @param {number} p.shots          shots in the film
 * @param {number} p.identityShots  shots routed to the reference-conditioned model
 * @param {number} p.references     reference images (fronts + three-quarters + places + objects)
 * @param {number} [p.failedShots]  shots that needed one retry
 * @param {number} [p.failedImages] images that needed one retry
 * @param {number} [p.speechMinutes] length of the recorded dream
 */
export function estimateReel({ shots, identityShots, references, failedShots = 0, failedImages = 0, speechMinutes = 1 }, u = UNIT) {
  const scenic = shots - identityShots;
  const video = (scenic * u.scenicPerSecond + identityShots * u.identityPerSecond) * u.shotSeconds;
  const retryVideo = failedShots * u.identityPerSecond * u.shotSeconds; // pessimistic: retries priced as identity shots
  const parts = {
    llm: 2 * u.directorCall + speechMinutes * u.transcribePerMinute,
    references: references * u.image,
    keyframes: shots * u.image,
    video,
    tts: shots * (u.ttsSecondsPerLine / 60) * u.ttsPerMinute,
    retries: retryVideo + failedImages * u.image,
  };
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  return { parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, round(v)])), total: round(total) };
}

/** What to reserve from the daily budget before starting (assumes every shot is an identity shot). */
export function reservationFor(maxShots) {
  return estimateReel({ shots: maxShots, identityShots: maxShots, references: Math.min(8, maxShots + 3) }).total;
}

const round = (x) => Math.round(x * 10000) / 10000;
