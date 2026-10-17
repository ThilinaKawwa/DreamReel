// Pre-merge hardening tests: environment isolation, access/credits config, private media
// paths, provider routing, reference packs, costs, narration guard, Guru lip sync/expressions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveWorkerTarget, deploymentEnv } from '../lib/cinema/env.js';
import { accessPlans, creditPeriod, shareMode } from '../lib/access-config.js';
import { mediaPath, ownsPath, allowedProviderUrl } from '../lib/cinema/media.js';
import { cinematicVerdict } from '../lib/cinema/verdict.js';
import { estimateReel, reservationFor } from '../lib/cinema/costs.js';
import { referencePlan, routeShot, usage } from '../lib/director/routing.js';
import { keyframeRequest, referencePrompt } from '../lib/director/compiler.js';
import { normalizeBible } from '../lib/director/bible.js';
import { normalizeStoryboard, soundsWritten } from '../lib/director/storyboard.js';
import { textToVisemes, visemeAt, wordVisemes, VISEMES } from '../lib/visemes.js';
import { parseGuruReply, EXPRESSIONS } from '../lib/guru-expression.js';

const PROD = { VERCEL_ENV: 'production', VERCEL_URL: 'dream-reel-abc123.vercel.app', VERCEL_PROJECT_PRODUCTION_URL: 'dreamreel.app', NEXT_PUBLIC_SITE_URL: 'https://dreamreel.app' };
const PREVIEW = { VERCEL_ENV: 'preview', VERCEL_URL: 'dream-reel-git-feature-x.vercel.app', VERCEL_BRANCH_URL: 'dream-reel-git-branch.vercel.app', VERCEL_PROJECT_PRODUCTION_URL: 'dreamreel.app', NEXT_PUBLIC_SITE_URL: 'https://dreamreel.app' };

// ---- 1. Environment isolation ------------------------------------------------------
test('PRODUCTION → PRODUCTION', () => {
  const t = resolveWorkerTarget(PROD);
  assert.equal(t.env, 'production');
  assert.equal(t.url, 'https://dreamreel.app');
});

test('PREVIEW → PREVIEW (its own deployment URL), never production', () => {
  const t = resolveWorkerTarget(PREVIEW);
  assert.equal(t.env, 'preview');
  assert.equal(t.url, 'https://dream-reel-git-feature-x.vercel.app');
  assert.notEqual(new URL(t.url).host, 'dreamreel.app');
});

test('PREVIEW ignores a REEL_WORKER_URL that points at production', () => {
  for (const bad of ['https://dreamreel.app', 'https://www.evil.example', 'https://dream-reel-abc123.vercel.app']) {
    const t = resolveWorkerTarget({ ...PREVIEW, REEL_WORKER_URL: bad });
    assert.equal(t.url, 'https://dream-reel-git-feature-x.vercel.app', bad);
  }
  // Its own branch URL is allowed.
  assert.equal(resolveWorkerTarget({ ...PREVIEW, REEL_WORKER_URL: 'https://dream-reel-git-branch.vercel.app' }).url, 'https://dream-reel-git-branch.vercel.app');
});

test('PREVIEW refuses if its own URL is somehow a production host', () => {
  const t = resolveWorkerTarget({ ...PREVIEW, VERCEL_URL: 'dreamreel.app' });
  assert.equal(t.url, null);
});

test('PREVIEW sends the Vercel protection bypass header when available', () => {
  const t = resolveWorkerTarget({ ...PREVIEW, VERCEL_AUTOMATION_BYPASS_SECRET: 'abc' });
  assert.equal(t.headers['x-vercel-protection-bypass'], 'abc');
  assert.equal(resolveWorkerTarget(PROD).headers['x-vercel-protection-bypass'], undefined);
});

test('LOCAL → in-process, or an explicit localhost worker only', () => {
  assert.equal(deploymentEnv({}), 'development');
  assert.equal(resolveWorkerTarget({}).url, null);
  assert.equal(resolveWorkerTarget({ NEXT_PUBLIC_SITE_URL: 'https://dreamreel.app' }).url, null, 'site URL is never used for routing');
  assert.equal(resolveWorkerTarget({ REEL_WORKER_URL: 'https://dreamreel.app' }).url, null, 'local never calls production');
  assert.equal(resolveWorkerTarget({ REEL_WORKER_URL: 'http://localhost:3000' }).url, 'http://localhost:3000');
});

test('the migration tags each production with its environment, and the worker filters on it', () => {
  const sql = readFileSync(new URL('../supabase/migrations/20261017_dream_director.sql', import.meta.url), 'utf8');
  assert.match(sql, /env text not null check \(env in \('production', 'preview', 'development'\)\)/);
  const prod = readFileSync(new URL('../lib/cinema/production.js', import.meta.url), 'utf8');
  assert.match(prod, /\.eq\('env', deploymentEnv\(\)\)/);
});

// ---- 2. Private media -----------------------------------------------------------------
const U = '11111111-1111-4111-8111-111111111111';
const D = '22222222-2222-4222-8222-222222222222';
test('media paths are built server-side inside the owner folder only', () => {
  assert.equal(mediaPath(U, D, 'kf-shot_01.jpg'), `${U}/${D}/kf-shot_01.jpg`);
  assert.equal(mediaPath(U, D, 'ref-character:brother_01.jpg'), `${U}/${D}/ref-character_brother_01.jpg`);
  assert.throws(() => mediaPath(U, D, '../other/reel.mp4'));
  assert.throws(() => mediaPath('not-a-user', D, 'reel.mp4'));
  assert.ok(ownsPath(`${U}/${D}/reel.mp4`, U, D));
  assert.ok(!ownsPath(`${U}/33333333-3333-4333-8333-333333333333/reel.mp4`, U, D));
  assert.ok(!ownsPath(`${U}/${D}/../x`, U, D));
});

test('only provider CDN media is fetched', () => {
  assert.ok(allowedProviderUrl('https://v3.fal.media/files/x.mp4'));
  assert.ok(!allowedProviderUrl('http://v3.fal.media/files/x.mp4'));
  assert.ok(!allowedProviderUrl('https://169.254.169.254/latest'));
  assert.ok(!allowedProviderUrl('https://fal.media.evil.com/x'));
});

test('the private bucket has no browser policies and new tables are server-only', () => {
  const sql = readFileSync(new URL('../supabase/migrations/20261017_dream_director.sql', import.meta.url), 'utf8');
  assert.match(sql, /'dream-media', 'dream-media', false/);
  assert.doesNotMatch(sql, /create policy[^;]*dream-media/);
  for (const t of ['dream_productions', 'reel_credits', 'generation_budget']) {
    assert.match(sql, new RegExp(`revoke all on public\\.${t} from anon, authenticated`), t);
  }
  assert.doesNotMatch(sql, /grant execute on function public\.(claim_reel_credit|refund_reel_credit|reserve_generation_budget)[^;]*authenticated/);
  assert.match(sql, /dream_id uuid unique references public\.dreams \(id\) on delete set null/, 'deleting a dream never returns its credit');
});

// ---- 3. Access model ------------------------------------------------------------------
test('free trial = ONE lifetime cinematic reel, no download, no Guru; sharing separate', () => {
  const p = accessPlans({}).free;
  assert.equal(p.cinematicReels, 1);
  assert.equal(p.period, 'lifetime');
  assert.equal(p.canDownload, false);
  assert.equal(p.canUseGuru, false);
  assert.equal(p.canShareLink, true);
  assert.equal(shareMode(p), 'link');
  assert.equal(shareMode({ ...p, canShareLink: false }), 'none');
  assert.equal(creditPeriod(p), 'lifetime');
});

test('premium = monthly allowance (default 4), download, Guru; all configurable', () => {
  const p = accessPlans({}).premium;
  assert.equal(p.cinematicReels, 4);
  assert.equal(p.canDownload, true);
  assert.equal(p.canUseGuru, true);
  assert.equal(shareMode(p), 'file');
  assert.equal(accessPlans({ PREMIUM_MONTHLY_REELS: '6' }).premium.cinematicReels, 6);
  assert.equal(creditPeriod(p, new Date('2026-09-30T23:30:00Z')), '2026-10', 'UK calendar month (00:30 BST on 1 Oct)');
  assert.equal(creditPeriod(p, new Date('2026-10-31T23:30:00Z')), '2026-10', 'GMT after clocks go back');
  assert.equal(creditPeriod(p, new Date('2026-10-16T12:00:00Z')), '2026-10');
});

// ---- 4. Fallback honesty ----------------------------------------------------------------
test('a film is cinematic only if every shot moved (or all but one in 4+ shots)', () => {
  assert.equal(cinematicVerdict(3, 3), 'cinematic');
  assert.equal(cinematicVerdict(3, 2), 'failed');
  assert.equal(cinematicVerdict(5, 4), 'cinematic_trimmed');
  assert.equal(cinematicVerdict(5, 3), 'failed');
  assert.equal(cinematicVerdict(0, 0), 'failed');
});

// ---- 5. Routing + reference packs ------------------------------------------------------
const brotherBible = normalizeBible({
  cleanedDream: 'I was walking around London with my brother. He had his red jacket on. We went into an old station and it flooded. We ran upstairs and ended up on a rooftop.',
  characters: [{ id: 'brother_01', role: "the dreamer's brother", face: 'oval face, light brown skin', hair: 'short dark curls', build: 'slim', clothing: 'red zip-up jacket, black jeans, white trainers' }],
  locations: [{ id: 'london_street_01', name: 'London street' }, { id: 'old_station_01', name: 'old station' }, { id: 'rooftop_01', name: 'rooftop' }],
  chronology: [{ event: 'walk' }, { event: 'station floods' }, { event: 'rooftop' }],
}, 'TEST A');
const brotherBoard = normalizeStoryboard({ shots: [
  { locationId: 'london_street_01', characterIds: ['brother_01'], visual: 'street', action: 'brother walks beside the camera', narration: 'I was walking around London with my brother.' },
  { locationId: 'old_station_01', characterIds: ['brother_01'], visual: 'station', action: 'water bursts through the doors', narration: 'Then the whole station just flooded.' },
  { locationId: 'old_station_01', visual: 'stairs, water rising', action: 'water rises up the stairs', narration: 'We ran upstairs.' },
  { locationId: 'rooftop_01', characterIds: ['brother_01'], visual: 'rooftop', action: 'brother turns to look back', narration: 'He still had that red jacket on.' },
] }, brotherBible, { maxShots: 5 });

test('routing: shots with the recurring brother use the reference model; scenic shots do not', () => {
  const routes = brotherBoard.shots.map((s) => routeShot(brotherBoard, s, {}));
  assert.deepEqual(routes.map((r) => r.mode), ['identity', 'identity', 'scenic', 'identity']);
  assert.equal(routes[0].provider, 'kling-o1-ref');
  assert.equal(routes[2].provider, 'kling-i2v');
  assert.deepEqual(routes[0].identityKeys, ['character:brother_01']);
  assert.equal(routeShot(brotherBoard, brotherBoard.shots[0], { IDENTITY_ROUTING: 'off' }).mode, 'scenic');
});

test('reference pack: brother gets front + three-quarter; only the repeated station gets a place reference', () => {
  const plan = referencePlan(brotherBible, brotherBoard).map((r) => r.key);
  assert.deepEqual(plan, ['character:brother_01', 'character:brother_01:three_quarter', 'location:old_station_01']);
  const tq = referencePlan(brotherBible, brotherBoard).find((r) => r.view === 'three_quarter');
  assert.equal(tq.from, 'character:brother_01', 'three-quarter is derived from the canonical front, not generated independently');
  assert.match(referencePrompt(brotherBible, tq), /SAME person as in Image 1/);
  assert.equal(usage(brotherBoard).character.brother_01, 3);
});

test('keyframe legend numbers match the images actually attached', () => {
  const available = new Set(['character:brother_01', 'location:old_station_01']);
  const street = keyframeRequest(brotherBible, brotherBoard.shots[0], available);
  assert.deepEqual(street.refs, ['character:brother_01']);
  assert.match(street.prompt, /Image 1 shows the dreamer's brother/);
  assert.doesNotMatch(street.prompt, /Image 2/);
  assert.match(street.prompt, /Place: London street/, 'unreferenced place described in words');
  const station = keyframeRequest(brotherBible, brotherBoard.shots[1], available);
  assert.deepEqual(station.refs, ['character:brother_01', 'location:old_station_01']);
  assert.match(station.prompt, /Image 2 shows the place \(old station\)/);
});

// ---- 6. Costs ------------------------------------------------------------------------------
test('cost model (list prices): 3-shot and 5-shot reels', () => {
  const free = estimateReel({ shots: 3, identityShots: 2, references: 3 });
  const paid = estimateReel({ shots: 5, identityShots: 3, references: 4 });
  assert.ok(free.total > 1 && free.total < 2.5, `free ${free.total}`);
  assert.ok(paid.total > 2 && paid.total < 4, `paid ${paid.total}`);
  assert.ok(reservationFor(5) >= paid.total, 'reservation covers a normal premium reel');
});

// ---- 7. Narration ----------------------------------------------------------------------------
test('narration guard: trailer prose is rejected, remembered speech is kept', () => {
  const bad = [
    'My brother and I ventured through the shadowed station as an unstoppable torrent consumed the world around us.',
    'Beneath an endless celestial horizon, the ocean ascended majestically toward the heavens.',
    'I found myself standing in an ethereal forest.',
    'The laws of nature surrendered.',
  ];
  const good = [
    'I remember walking through the station with my brother. He still had his red jacket on.',
    'Then water started coming through the doors.',
    'It was like London, but sort of not.',
    'I think the door was black? Yeah, black.',
  ];
  for (const l of bad) assert.equal(soundsWritten(l), true, l);
  for (const l of good) assert.equal(soundsWritten(l), false, l);
});

// ---- 8. Guru ------------------------------------------------------------------------------------
test('visemes: shapes follow the words and fill the audio length', () => {
  assert.deepEqual(wordVisemes('moon'), ['MBP', 'O', 'L']);
  assert.ok(wordVisemes('five').includes('FV'));
  const track = textToVisemes('Perhaps the water was you. What did it feel like?', 3.2);
  assert.equal(track[0].t, 0);
  assert.equal(track[track.length - 1].t, 3.2);
  assert.ok(track.every((x) => VISEMES[x.v]), 'every shape exists');
  assert.ok(new Set(track.map((x) => x.v)).size >= 5, 'several distinct mouth shapes');
  assert.equal(visemeAt(track, -1), 'rest');
  assert.equal(visemeAt(track, 99), 'rest');
});

test('guru expression comes from validated model metadata', () => {
  assert.deepEqual(parseGuruReply('{"text":"That could reflect change.","expression":"thoughtful"}'), { text: 'That could reflect change.', expression: 'thoughtful' });
  assert.equal(parseGuruReply('{"text":"Hi","expression":"furious"}').expression, null, 'unknown expression rejected');
  assert.equal(parseGuruReply('{"text":"Hi","expression":"<script>"}').expression, null);
  assert.equal(parseGuruReply('plain text').text, 'plain text');
  assert.equal(EXPRESSIONS.length, 7);
});

test('scene links only ever sign keyframe pictures (not the film) even if a row is edited', () => {
  const src = readFileSync(new URL('../lib/cinema/scene-links.js', import.meta.url), 'utf8');
  const re = new RegExp(src.match(/KEYFRAME = \/(.+)\/;/)[1]);
  assert.ok(re.test(`${U}/${D}/kf-shot_01.jpg`));
  assert.ok(!re.test(`${U}/${D}/reel.mp4`));
  assert.ok(!re.test(`${U}/${D}/kf-shot_01.jpg/../reel.mp4`));
  assert.ok(!re.test(`${U}/${D}/voice-shot_01.wav`));
});
