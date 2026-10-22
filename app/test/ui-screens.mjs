// Screenshots of the Guru-first screens at phone size, on the test stack (real app + real
// Postgres; fake Auth and OpenAI). Not part of `npm test` — run by hand:
//   PG_HOST=… PGRST_BIN=… PLAYWRIGHT=/path/to/playwright OUT=/some/dir node test/ui-screens.mjs
import { startStack, A } from './harness/app.mjs';

const { PG_HOST, PG_PORT = '5432', PGRST_BIN: BIN, PLAYWRIGHT, OUT } = process.env;
if (!PG_HOST || !BIN || !PLAYWRIGHT || !OUT) { console.log('SKIPPED (set PG_HOST, PGRST_BIN, PLAYWRIGHT, OUT)'); process.exit(0); }
const { chromium } = await import(`${PLAYWRIGHT}/index.mjs`);
const stack = await startStack({ PG_HOST, PG_PORT, BIN });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const WEB = stack.base.replace('127.0.0.1', 'localhost'); // next dev only serves its scripts to localhost
const shot = async (name) => { await page.waitForTimeout(1200); await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true }); console.log('saved', name); };

try {
  // 1. Brand-new person: onboarding, then Orin's home
  await page.goto(WEB, { waitUntil: 'networkidle' });
  await shot('01-onboarding-meet-orin');
  await page.getByRole('button', { name: 'Continue' }).click();
  await shot('02-onboarding-privacy');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: /Not now/ }).click();
  await shot('03-home-first-time');

  // 2. Type a dream (text mode = same conversation)
  await page.getByRole('button', { name: 'Prefer to type?' }).click();
  await page.getByLabel(/Write to/).fill('I was walking through a forest and I saw this silver door.');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByText('How did you feel').first().waitFor({ timeout: 60000 });
  await shot('04-text-mode-first-dream');
  await page.getByLabel(/Write to/).fill('Curious, actually. Not scared.');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByText('Curious rather than afraid').first().waitFor({ timeout: 60000 });
  await page.getByRole('button', { name: 'Use voice' }).click();
  await shot('05-home-after-capture');

  // 3. More dreams so there is history, via the API as the same person
  await stack.talk(A, { text: 'I was at a station with my brother, trying to leave.' });
  await stack.talk(A, { text: 'My brother was there again, this time at the beach.' });
  await stack.waitFor(() => stack.q1(`select count(*) from dream_memories where status = 'ready'`) === '3', 30000);

  await page.goto(`${WEB}/dreams`, { waitUntil: 'networkidle' });
  await shot('06-my-dreams');
  const id = stack.q1(`select id from dreams where transcript like '%station%'`);
  await page.goto(`${WEB}/d/${id}`, { waitUntil: 'networkidle' });
  await page.getByText('The dream').first().waitFor();
  await shot('07-dream-detail');
  await page.goto(`${WEB}/insights`, { waitUntil: 'networkidle' });
  await shot('08-insights');
  await page.goto(`${WEB}/gallery`, { waitUntil: 'networkidle' });
  await shot('09-visual-memories-empty');
  await page.goto(WEB, { waitUntil: 'networkidle' });
  await shot('10-home-returning');
} catch (e) {
  console.error(e);
  await page.screenshot({ path: `${OUT}/error.png`, fullPage: true }).catch(() => {});
}
console.log('page errors:', JSON.stringify(errors));
await browser.close();
stack.stop();
process.exit(0);
