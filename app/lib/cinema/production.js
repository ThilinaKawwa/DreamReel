// CINEMATIC PRODUCTION — the resumable state machine that turns a dream into a film.
//
//   budget → understanding → storyboard → references → keyframes → animating → voice → editing → done
//
// Every step saves its results in dream_productions, so a timeout, crash or failed shot
// resumes exactly where it stopped: if shot 4 fails, ONLY shot 4 is retried — the
// DreamBible, references, keyframes and good clips are never regenerated.
// All media goes to the PRIVATE `dream-media` bucket. Runs with the service role.
import OpenAI from 'openai';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DIRECTOR_VERSION, BIBLE_PROMPT_VERSION, buildDreamBible } from '@/lib/director/bible';
import { STORYBOARD_PROMPT_VERSION, buildStoryboard } from '@/lib/director/storyboard';
import { COMPILER_VERSION, referencePrompt, keyframeRequest, videoRequest } from '@/lib/director/compiler';
import { referencePlan, routeShot } from '@/lib/director/routing';
import { imageProvider, videoProvider } from '@/lib/providers';
import { accessPlans, refundCredit } from '@/lib/entitlements';
import { speakLine } from '@/lib/reel/voice';
import { renderReel } from '@/lib/reel/render';
import { soundtrackFor, FONTS_DIR } from '@/lib/reel/assets';
import { BRAND, siteDomain } from '@/lib/brand';
import { checkClip } from '@/lib/cinema/quality';
import { reservationFor, UNIT } from '@/lib/cinema/costs';
import { MEDIA_BUCKET, mediaPath, storeFromProvider, storeBytes, readBytes, signedUrl } from '@/lib/cinema/media';
import { deploymentEnv } from '@/lib/cinema/env';
import { cinematicVerdict } from '@/lib/cinema/verdict';
import { logEvent } from '@/lib/analytics-server';

export const MAX_SHOT_ATTEMPTS = 3; // first try + 2 automatic retries, per shot
const MAX_IMAGE_ATTEMPTS = 2;
const CLIP_TIMEOUT_MS = 12 * 60 * 1000; // a clip unfinished after 12 minutes is retried
const PROVIDER_LINK_SECONDS = 6 * 3600; // signed links handed to the video model
export const CINEMATIC_FAILED = "We couldn't finish the cinematic version of this dream.";
const BUSY = 'Dream Reel is very busy right now. Your credit has been returned — please try again later.';

const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cents = (usd) => Math.round(usd * 1000) / 10; // one decimal of a cent
const budgetCapCents = () => Math.round(Number(process.env.REEL_DAILY_BUDGET_USD || 25) * 100);

export function cinematicAvailable() {
  return Boolean(process.env.FAL_KEY && process.env.OPENAI_API_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/**
 * Advances one production as far as it can before `deadline` (ms timestamp).
 * Returns 'done' | 'waiting' (call again later) | 'locked' (another worker has it).
 */
export async function advanceProduction(admin, dreamId, deadline) {
  // One worker at a time, and only a worker of the environment that created the job.
  const { data: claimed } = await admin.from('dream_productions')
    .update({ lock_until: new Date(deadline + 30_000).toISOString(), updated_at: now() })
    .eq('dream_id', dreamId).eq('env', deploymentEnv()).in('status', ['queued', 'processing'])
    .or(`lock_until.is.null,lock_until.lt.${now()}`)
    .select().maybeSingle();
  if (!claimed) return 'locked';

  let p = claimed;
  const save = async (patch) => {
    p = { ...p, ...patch };
    await admin.from('dream_productions').update({ ...patch, updated_at: now() }).eq('dream_id', dreamId);
  };
  const cost = { llm: 0, references: 0, keyframes: 0, video: 0, tts: 0, retries: 0, ...(p.cost || {}) };
  const addCost = (part, usd) => {
    cost[part] = Math.round((cost[part] + cents(usd)) * 10) / 10;
    p.cost_cents = Math.round(Object.values(cost).reduce((a, b) => a + b, 0));
  };
  const costPatch = () => ({ cost, cost_cents: p.cost_cents || 0 });
  const timeLeft = () => deadline - Date.now();
  const plan = accessPlans()[p.tier === 'premium' ? 'premium' : 'free'];

  try {
    const { data: dream } = await admin.from('dreams').select('id, user_id, transcript, status, title').eq('id', dreamId).maybeSingle();
    if (!dream || dream.user_id !== p.user_id) throw new Error('dream missing');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const assets = p.assets || {};
    assets.references ||= {}; assets.keyframes ||= {}; assets.clips ||= {}; assets.voice ||= {};
    const own = (name) => mediaPath(p.user_id, dreamId, name);
    const images = imageProvider();

    if (!p.meta?.director_model) {
      await save({
        meta: {
          director_model: process.env.DIRECTOR_MODEL || 'gpt-4.1',
          reference_model: images.model, keyframe_model: images.editModel,
          identity_video: videoProvider(process.env.IDENTITY_VIDEO_PROVIDER || 'kling-o1-ref').model,
          scenic_video: videoProvider(process.env.SCENIC_VIDEO_PROVIDER || 'kling-i2v').model,
          prompt_versions: { bible: BIBLE_PROMPT_VERSION, storyboard: STORYBOARD_PROMPT_VERSION, compiler: COMPILER_VERSION },
          env: p.env, deployment: process.env.VERCEL_DEPLOYMENT_ID || null,
        },
      });
    }

    // 0. BUDGET — reserve the worst normal cost BEFORE spending anything (concurrency-safe in SQL).
    if (!p.budget_reserved_cents) {
      const reserve = Math.ceil(reservationFor(plan.maxShots) * 100);
      const { data: ok, error } = await admin.rpc('reserve_generation_budget', { p_cents: reserve, p_cap_cents: budgetCapCents() });
      if (error) throw new Error(`budget: ${error.message}`);
      if (!ok) {
        await save({ status: 'failed', stage: null, error: BUSY, lock_until: null });
        await refundCredit(p.credit_id, p.tier);
        await logEvent(admin, p.user_id, 'reel_budget_blocked', {});
        return 'done';
      }
      assets.budgetDay = new Date().toISOString().slice(0, 10);
      await save({ budget_reserved_cents: reserve, assets, status: 'processing' });
    }

    // 1. UNDERSTANDING — the DreamBible
    if (!p.bible) {
      await save({ status: 'processing', stage: 'understanding' });
      const bible = await buildDreamBible(openai, dream.transcript);
      addCost('llm', UNIT.llmDirector / 2 + UNIT.transcribe);
      await save({ bible, ...costPatch() });
      await logEvent(admin, p.user_id, 'dream_parse_completed', { characters: bible.characters.length, locations: bible.locations.length, objects: bible.objects.length });
    }
    const bible = p.bible;

    // 2. STORYBOARD
    if (!p.storyboard) {
      await save({ stage: 'storyboard' });
      const storyboard = await buildStoryboard(openai, bible, { maxShots: plan.maxShots });
      addCost('llm', UNIT.llmDirector / 2);
      await save({ storyboard, ...costPatch() });
      await admin.from('dreams').update({ title: storyboard.title }).eq('id', dreamId);
      await logEvent(admin, p.user_id, 'storyboard_completed', { shots: storyboard.shots.length, narration_replaced: storyboard.narrationReplaced });
    }
    const storyboard = p.storyboard;
    const shots = storyboard.shots;

    // 3. REFERENCES — the smallest useful canonical pack (fronts, then three-quarters from the fronts)
    const refPlan = referencePlan(bible, storyboard);
    const todo = (r) => !assets.references[r.key]?.path && (assets.references[r.key]?.attempts || 0) < MAX_IMAGE_ATTEMPTS;
    for (const wave of [refPlan.filter((r) => !r.from), refPlan.filter((r) => r.from)]) {
      const jobs = wave.filter(todo).filter((r) => !r.from || assets.references[r.from]?.path);
      if (!jobs.length) continue;
      await save({ stage: 'references' });
      await Promise.all(jobs.map(async (r) => {
        const prev = assets.references[r.key] || { attempts: 0 };
        try {
          const prompt = referencePrompt(bible, r);
          const out = r.from
            ? await images.edit({ prompt, imageUrls: [await signedUrl(admin, assets.references[r.from].path, PROVIDER_LINK_SECONDS)], aspect: '3:4' })
            : await images.generate({ prompt, aspect: r.kind === 'location' ? '9:16' : '3:4' });
          addCost(prev.attempts ? 'retries' : 'references', out.cost);
          const stored = await storeFromProvider(admin, own(`ref-${r.key}.jpg`), out.url, 'image/', 20e6);
          assets.references[r.key] = { path: stored.path, model: out.model, view: r.view, attempts: prev.attempts + 1 };
          if (r.kind === 'character' && r.view === 'front') await logEvent(admin, p.user_id, 'character_reference_generated', {});
        } catch (e) {
          assets.references[r.key] = { ...prev, attempts: prev.attempts + 1, error: String(e.message).slice(0, 160) };
        }
      }));
      await save({ assets, ...costPatch() });
    }
    const available = new Set(Object.entries(assets.references).filter(([, v]) => v.path).map(([k]) => k));

    // 4. KEYFRAMES — each shot's first frame, generated FROM the references that exist
    const kfJobs = shots.filter((s) => !assets.keyframes[s.id]?.path && (assets.keyframes[s.id]?.attempts || 0) < MAX_IMAGE_ATTEMPTS);
    if (kfJobs.length) {
      await save({ stage: 'keyframes' });
      await Promise.all(kfJobs.map(async (shot) => {
        const prev = assets.keyframes[shot.id] || { attempts: 0 };
        const req = keyframeRequest(bible, shot, available);
        try {
          const refUrls = (await Promise.all(req.refs.map((k) => signedUrl(admin, assets.references[k].path, PROVIDER_LINK_SECONDS)))).filter(Boolean);
          const out = refUrls.length ? await images.edit({ prompt: req.prompt, imageUrls: refUrls }) : await images.generate({ prompt: req.prompt });
          addCost(prev.attempts ? 'retries' : 'keyframes', out.cost);
          const stored = await storeFromProvider(admin, own(`kf-${shot.id}.jpg`), out.url, 'image/', 20e6);
          assets.keyframes[shot.id] = { path: stored.path, model: out.model, refs: req.refs, attempts: prev.attempts + 1 };
        } catch (e) {
          assets.keyframes[shot.id] = { ...prev, attempts: prev.attempts + 1, error: String(e.message).slice(0, 160) };
        }
      }));
      await save({ assets, ...costPatch() });
    }
    const framed = shots.filter((s) => assets.keyframes[s.id]?.path);
    if (framed.length < Math.min(2, shots.length)) throw new Error('not enough keyframes');

    // The dream's pictures are PRIVATE paths; owners get short-lived signed links from the server.
    if (dream.status !== 'ready') {
      const scenes = framed.map((s) => ({ caption: s.narration || '', shot_id: s.id, image_path: assets.keyframes[s.id].path }));
      await admin.from('dreams').update({ scenes, status: 'ready', title: storyboard.title }).eq('id', dreamId);
    }

    // 5. ANIMATING — real video per shot; identity shots use the reference-conditioned model
    await save({ stage: 'animating' });
    while (true) {
      let pending = 0;
      for (const shot of framed) {
        const c = assets.clips[shot.id] || { attempts: 0, extraAttempts: 0 };
        const maxAttempts = MAX_SHOT_ATTEMPTS + (c.extraAttempts || 0);
        if (c.status === 'done' || (c.status === 'failed' && c.attempts >= maxAttempts)) continue;
        const timedOut = c.status === 'pending' && Date.now() - new Date(c.submittedAt).getTime() > CLIP_TIMEOUT_MS;
        if (!c.requestId || c.status === 'failed' || timedOut) {
          if (c.attempts >= maxAttempts) { assets.clips[shot.id] = { ...c, status: 'failed' }; continue; }
          const sub = await submitShot(admin, { p, bible, storyboard, shot, assets, own, retry: c.attempts > 0 });
          if (sub.cost) addCost(c.attempts > 0 ? 'retries' : 'video', sub.cost);
          assets.clips[shot.id] = { ...c, ...sub.record, attempts: c.attempts + 1 };
          if (sub.record.status === 'pending') await logEvent(admin, p.user_id, 'video_clip_started', { attempt: c.attempts + 1, mode: sub.record.mode });
          if (sub.record.status !== 'failed' || c.attempts + 1 < maxAttempts) pending++;
          continue;
        }
        const st = await videoProvider(c.provider).check(c.requestId);
        if (st.status === 'done') {
          const verdict = await keepClip(admin, st.url, own(`clip-${shot.id}.mp4`));
          if (verdict.ok) {
            assets.clips[shot.id] = { ...c, status: 'done', path: verdict.path, seconds: verdict.seconds, doneAt: now(), error: null };
            await logEvent(admin, p.user_id, 'video_clip_completed', { attempt: c.attempts, mode: c.mode });
          } else {
            assets.clips[shot.id] = { ...c, status: 'failed', error: `quality: ${verdict.reason}` };
            await logEvent(admin, p.user_id, 'video_clip_failed', { attempt: c.attempts, mode: c.mode, quality: true });
            if (c.attempts < maxAttempts) pending++;
          }
        } else if (st.status === 'failed') {
          assets.clips[shot.id] = { ...c, status: 'failed', error: st.error };
          await logEvent(admin, p.user_id, 'video_clip_failed', { attempt: c.attempts, mode: c.mode });
          if (c.attempts < maxAttempts) pending++;
        } else pending++;
      }
      await save({ assets, ...costPatch() });
      if (!pending) break;
      if (timeLeft() < 25_000) return 'waiting';
      await sleep(8000);
    }

    const good = framed.filter((s) => assets.clips[s.id]?.status === 'done');
    const verdict = cinematicVerdict(framed.length, good.length);
    if (verdict === 'failed') {
      // Do NOT hand the user a slideshow as if it were the film. Optionally keep a debug fallback.
      let renderer = null;
      if (process.env.REEL_DEBUG_FALLBACK === 'true' && timeLeft() > 150_000) {
        await editFilm(admin, p, framed, assets, { stillsOnly: true, name: 'debug-fallback' }).catch((e) => console.error('debug fallback failed', e));
        renderer = 'image_fallback';
      }
      await finish(admin, p, save, assets, { status: 'failed', renderer_type: renderer, error: CINEMATIC_FAILED });
      await refundCredit(p.credit_id, p.tier);
      await logEvent(admin, p.user_id, 'cinematic_failed', { shots: framed.length, good: good.length });
      return 'done';
    }

    // 6. VOICE — the dreamer's remembered narration, one short line per shot
    const missingVoice = good.filter((s) => s.narration && !assets.voice[s.id] && !(assets.voiceFailed || []).includes(s.id));
    if (missingVoice.length) {
      await save({ stage: 'voice' });
      const failed = assets.voiceFailed || [];
      await Promise.all(missingVoice.map(async (s) => {
        const spoken = await speakLine(openai, s.narration);
        if (!spoken) { failed.push(s.id); return; }
        try {
          const vp = await storeBytes(admin, own(`voice-${s.id}.wav`), spoken.wav, 'audio/wav');
          assets.voice[s.id] = { path: vp, seconds: spoken.seconds };
          addCost('tts', UNIT.ttsPerLine);
        } catch { failed.push(s.id); }
      }));
      assets.voiceFailed = failed;
      await save({ assets, ...costPatch() });
    }
    if (timeLeft() < 150_000) return 'waiting'; // editing needs a clear run

    // 7. EDITING — assemble the film from the checked clips
    await save({ stage: 'editing' });
    const result = await editFilm(admin, p, good, assets, { name: 'reel' });
    const done = now();
    await admin.from('dream_reels').upsert({
      dream_id: dreamId, user_id: p.user_id, status: 'completed', stage: null,
      narration: { lines: result.lines, mood: bible.mood, source: 'director', voiced: result.voiced },
      soundtrack: result.soundtrack, video_path: result.videoPath, poster_path: result.posterPath,
      duration_seconds: Math.round(result.seconds * 10) / 10, size_bytes: result.bytes, width: 1080, height: 1920,
      error: null, attempts: 1, started_at: p.started_at, completed_at: done, updated_at: done,
      renderer_type: 'cinematic_video', generation_version: p.generation_version,
    }, { onConflict: 'dream_id' });
    await finish(admin, p, save, assets, { status: 'completed', renderer_type: 'cinematic_video', completed_at: done, error: null }, costPatch());
    await logEvent(admin, p.user_id, 'reel_completed', { renderer: 'cinematic_video', shots: good.length, seconds: Math.round(result.seconds), cost_cents: p.cost_cents });
    return 'done';
  } catch (e) {
    console.error('production failed', dreamId, e?.message || e);
    const assets = { ...(p.assets || {}), runFailures: (p.assets?.runFailures || 0) + 1, lastError: String(e.message).slice(0, 200) };
    if (assets.runFailures >= 3) {
      await finish(admin, p, save, assets, { status: 'failed', error: CINEMATIC_FAILED }, costPatch());
      await refundCredit(p.credit_id, p.tier);
      await logEvent(admin, p.user_id, 'cinematic_failed', { stage: p.stage || 'unknown' });
      return 'done';
    }
    await save({ assets, ...costPatch(), lock_until: null });
    return 'waiting';
  } finally {
    // Hand the job back so the next run (or a page poll) can pick it up at once.
    await admin.from('dream_productions').update({ lock_until: null }).eq('dream_id', dreamId).then(() => {}, () => {});
  }
}

/** Terminal state: releases the budget reservation and records actual spend. */
async function finish(admin, p, save, assets, patch, extra = {}) {
  const day = assets.budgetDay;
  if (day && p.budget_reserved_cents) {
    const spent = Math.max(0, (p.cost_cents || 0) - (assets.budgetSettledCents || 0));
    await admin.rpc('settle_generation_budget', { p_day: day, p_reserved_cents: p.budget_reserved_cents, p_spent_cents: spent });
    assets.budgetSettledCents = p.cost_cents || 0;
  }
  await save({ ...patch, ...extra, stage: null, assets, budget_reserved_cents: 0, lock_until: null });
}

/** Submits one shot to the right video model. Retries reserve their own budget first. */
async function submitShot(admin, { p, bible, storyboard, shot, assets, own, retry }) {
  const route = routeShot(storyboard, shot);
  const vr = videoRequest(bible, shot);
  // Identity shots need their canonical references; if those failed, use the scenic mode.
  const elements = route.identityKeys.filter((k) => assets.references[k]?.path);
  const mode = route.mode === 'identity' && elements.length ? 'identity' : 'scenic';
  const video = videoProvider(mode === 'identity' ? route.provider : (process.env.SCENIC_VIDEO_PROVIDER || 'kling-i2v'));
  const shotCost = video.costPerSecond * vr.duration;
  if (retry) {
    const { data: ok } = await admin.rpc('reserve_generation_budget', { p_cents: Math.ceil(shotCost * 100), p_cap_cents: budgetCapCents() });
    if (!ok) return { record: { status: 'failed', error: 'daily budget reached', mode, provider: video.id, model: video.model } };
    p.budget_reserved_cents = (p.budget_reserved_cents || 0) + Math.ceil(shotCost * 100);
    await admin.from('dream_productions').update({ budget_reserved_cents: p.budget_reserved_cents }).eq('dream_id', p.dream_id);
  }
  try {
    const startImageUrl = await signedUrl(admin, assets.keyframes[shot.id].path, PROVIDER_LINK_SECONDS);
    const els = mode === 'identity' ? await Promise.all(elements.map(async (k) => {
      const frontal = await signedUrl(admin, assets.references[k].path, PROVIDER_LINK_SECONDS);
      const tq = assets.references[`${k}:three_quarter`]?.path;
      const extra = tq ? await signedUrl(admin, tq, PROVIDER_LINK_SECONDS) : null;
      return { label: vr.labels?.[k] || k.split(':')[1], frontal, references: [extra || frontal] };
    })) : [];
    const { requestId } = await video.submit({ startImageUrl, prompt: vr.prompt, negative: vr.negative, duration: vr.duration, elements: els });
    return { cost: shotCost, record: { status: 'pending', requestId, mode, provider: video.id, model: video.model, submittedAt: now(), error: null } };
  } catch (e) {
    return { record: { status: 'failed', error: String(e.message).slice(0, 160), mode, provider: video.id, model: video.model } };
  }
}

/** Downloads a finished clip into private storage and checks it before accepting it. */
async function keepClip(admin, url, storePath) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clip-'));
  try {
    const stored = await storeFromProvider(admin, storePath, url, 'video/', 80e6);
    const file = path.join(dir, 'clip.mp4');
    await writeFile(file, stored.bytes);
    const q = await checkClip(file);
    return q.ok ? { ok: true, path: storePath, seconds: q.seconds } : { ok: false, reason: q.reason };
  } catch (e) {
    return { ok: false, reason: String(e.message).slice(0, 120) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Renders the film from private media and uploads it privately. */
async function editFilm(admin, p, shots, assets, { stillsOnly = false, name }) {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'film-'));
  try {
    const scenes = [];
    const voices = [];
    const lines = [];
    for (const s of shots) {
      const image = path.join(workDir, `${s.id}.jpg`);
      await writeFile(image, await readBytes(admin, assets.keyframes[s.id].path));
      let clip = null;
      let clipSeconds = null;
      const c = assets.clips[s.id];
      if (!stillsOnly && c?.status === 'done' && c.path) {
        clip = path.join(workDir, `${s.id}.mp4`);
        await writeFile(clip, await readBytes(admin, c.path));
        clipSeconds = c.seconds;
      }
      let voice = null;
      if (assets.voice[s.id]) {
        const vf = path.join(workDir, `${s.id}.wav`);
        await writeFile(vf, await readBytes(admin, assets.voice[s.id].path));
        voice = { file: vf, seconds: assets.voice[s.id].seconds };
      }
      scenes.push({ image, clip, clipSeconds });
      voices.push(voice);
      lines.push(s.narration || '');
    }
    const soundtrack = soundtrackFor(p.bible.mood);
    const out = await renderReel({
      workDir, scenes, voices, lines, music: soundtrack?.file || null, fontsDir: FONTS_DIR,
      brand: { footer: BRAND.footer, title: BRAND.name, tagline: BRAND.tagline, domain: siteDomain() },
    });
    const { readFile } = await import('node:fs/promises');
    const videoPath = mediaPath(p.user_id, p.dream_id, `${name}.mp4`);
    const posterPath = mediaPath(p.user_id, p.dream_id, `${name}-poster.jpg`);
    await storeBytes(admin, videoPath, await readFile(out.video), 'video/mp4');
    await storeBytes(admin, posterPath, await readFile(out.poster), 'image/jpeg');
    return {
      seconds: out.seconds, bytes: out.bytes, soundtrack: soundtrack?.id || null, videoPath, posterPath,
      lines, voiced: voices.map((v) => (v ? v.seconds : null)),
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * A person's retry of a failed cinematic production: only failed shots get fresh attempts;
 * the DreamBible, references, keyframes and good clips are kept. Returns false if not allowed.
 */
export async function requeueProduction(admin, prod, maxUserRetries = 1) {
  const assets = { ...(prod.assets || {}) };
  if ((assets.userRetries || 0) >= maxUserRetries) return false;
  assets.userRetries = (assets.userRetries || 0) + 1;
  assets.runFailures = 0;
  delete assets.budgetDay;
  for (const [id, c] of Object.entries(assets.clips || {})) {
    if (c.status !== 'done') assets.clips[id] = { ...c, status: 'failed', extraAttempts: (c.extraAttempts || 0) + 2 };
  }
  for (const kind of ['references', 'keyframes']) {
    for (const [k, v] of Object.entries(assets[kind] || {})) if (!v.path) assets[kind][k] = { ...v, attempts: 0 };
  }
  const { error } = await admin.from('dream_productions')
    .update({ status: 'queued', stage: null, error: null, renderer_type: null, assets, budget_reserved_cents: 0, lock_until: null, updated_at: now() })
    .eq('dream_id', prod.dream_id).eq('status', 'failed');
  return !error;
}

export { DIRECTOR_VERSION, MEDIA_BUCKET, cinematicVerdict };
