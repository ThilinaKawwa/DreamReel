// One real Replicate request (~one 5 s Kling 2.5 clip — check the price on the model page first).
// Run from the app folder on a machine with internet:
//   REPLICATE_API_TOKEN=r8_... PRICE_REPLICATE_KLING_25_PER_S=<price> node scripts/replicate-contract.mjs <public-image-url>
import { replicateVideoProvider } from '../lib/providers/replicate.js';

const image = process.argv[2];
if (!image || !/^https:\/\//.test(image)) { console.error('usage: node scripts/replicate-contract.mjs <https image url>'); process.exit(1); }
const video = replicateVideoProvider();
const t0 = Date.now();
const { requestId } = await video.submit({ startImageUrl: image, prompt: 'Slow push in; gentle wind moves the scene.', negative: 'text, watermark', duration: 5 });
console.log('request accepted:', requestId);
for (let i = 0; i < 90; i++) {
  const st = await video.check(requestId);
  if (st.status !== 'pending') {
    console.log(JSON.stringify({ ...st, seconds_waited: Math.round((Date.now() - t0) / 1000), est_cost_usd: video.costPerSecond * 5 }, null, 2));
    process.exit(st.status === 'done' ? 0 : 1);
  }
  await new Promise((r) => setTimeout(r, 10_000));
}
console.error('still pending after 15 minutes'); process.exit(1);
