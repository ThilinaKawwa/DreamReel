// CINEMATIC PRODUCTION — the resumable state machine that turns a dream into a film.
//
//   understanding → storyboard → references → keyframes → animating → voice → editing → checking → done
//
// Every step saves its results in dream_productions.assets, so a timeout, a crash or
// a failed shot resumes exactly where it stopped: if shot 4 fails, only shot 4 is retried.
// Runs with the service-role client (server only); ownership comes from the row itself.
import OpenAI from 'openai';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DIRECTOR_VERSION, buildDreamBible } from '@/lib/director/bible';
import { buildStoryboard } from '@/lib/director/storyboard';
import { referencePrompts, keyframeRequest, videoRequest } from '@/lib/director/compiler';
import { imageProvider, videoProvider } from '@/lib/providers';
import { TIER_PLAN } from '@/lib/entitlements';
import { speakLine } from '@/lib/reel/voice';
import { renderReel } from '@/lib/reel/render';
import { soundtrackFor, FONTS_DIR } from '@/lib/reel/assets';
import { BRAND, siteDomain } from '@/lib/brand';
import { REEL_BUCKET, reelPaths } from '@/lib/reel/pipeline';
import { checkClip } from '@/lib/cinema/quality';
import { logEvent } from '@/lib/analytics-server';
import { releaseSlot } from '@/lib/cinema/start';

export const MAX_SHOT_ATTEMPTS = 3; // first try + 2 retries, per shot
const MAX_IMAGE_ATTEMPTS = 2;
const CLIP_TIMEOUT_MS = 12 * 60 * 1000; // a clip that hasn't finished in 12 minutes is retried
const DAILY_BUDGET_CENTS = Math.round(Number(process.env.REEL_DAILY_BUDGET_USD || 25) * 100);

const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function cinematicAvailable() {
  return Boolean(process.env.FAL_KEY && process.env.OPENAI_API_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/** Has the platform spent its daily video budget? (Hard cost safeguard.) */
async function overBudget(admin) {
  const since = new Date(); since.setUTCHours(0, 0, 0, 0);
  const { data } = await admin.from('dream_productions').select('cost_cents').gte('started_at', since.toISOString());
  const spent = (data || []).reduce((n, r) => n + (r.cost_cents || 0), 0);
  return spent >= DAILY_BUDGET_CENTS;
}

/**
 * Advances one production as far as it can before `deadline` (ms timestamp).
 * Returns 'done' | 'waiting' (call again later) | 'locked' (another worker has it).
 */
export async function advanceProduction(admin, dreamId, deadline) {
  // One worker at a time: take the lock only if it is free or expired.
  const lockUntil = new Date(deadline + 30_000).toISOString();
  const { data: claimed } = await admin.from('dream_productions')
    .update({ lock_until: lockUntil, updated_at: now() })
    .eq('dream_id', dreamId).in('status', ['queued', 'processing'])
    .or(`lock_until.is.null,lock_until.lt.${now()}`)
    .select().maybeSingle();
  if (!claimed) return 'locked';

  let p = claimed;
  const save = async (patch) => {
    p = { ...p, ...patch, updated_at: now() };
    await admin.from('dream_productions').update({ ...patch, updated_at: now() }).eq('dream_id', dreamId);
  };
  const addCost = (usd) => { p.cost_cents = (p.cost_cents || 0) + Math.round(usd * 100); };
  const timeLeft = () => deadline - Date.now();

  try {
    const { data: dream } = await admin.from('dreams').select('*').eq('id', dreamId).maybeSingle();
    if (!dream) throw new Error('dream missing');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const assets = p.assets || {};
    assets.references ||= {}; assets.keyframes ||= {}; assets.clips ||= {}; assets.voice ||= {};

    // 1. UNDERSTANDING — the DreamBible
    if (!p.bible) {
      await save({ status: 'processing', stage: 'understanding' });
      const bible = await buildDreamBible(openai, dream.transcript);
      addCost(0.03);
      await save({ bible, cost_cents: p.cost_cents });
      await logEvent(admin, p.user_id, 'dream_parse_completed', { characters: bible.characters.length, locations: bible.locations.length, objects: bible.objects.length });
    }
    const bible = p.bible;

    // 2. STORYBOARD
    if (!p.storyboard) {
      await save({ stage: 'storyboard' });
      const storyboard = await buildStoryboard(openai, bible, { maxShots: TIER_PLAN[p.tier]?.maxShots || 3 });
      addCost(0.03);
      await save({ storyboard, cost_cents: p.cost_cents });
      await admin.from('dreams').update({ title: storyboard.title }).eq('id', dreamId);
      await logEvent(admin, p.user_id, 'storyboard_completed', { shots: storyboard.shots.length, narration_replaced: storyboard.narrationReplaced });
    }
    const shots = p.storyboard.shots;
    const images = imageProvider();

    // 3. REFERENCES — one canonical image per character, place and object (only those used in shots)
    const used = new Set(shots.flatMap((s) => [`location:${s.locationId}`, ...s.characterIds.map((c) => `character:${c}`), ...s.objectIds.map((o) => `object:${o}`)]));
    const refJobs = referencePrompts(bible).filter((r) => used.has(r.key) && !assets.references[r.key]?.url && (assets.references[r.key]?.attempts || 0) < MAX_IMAGE_ATTEMPTS);
    if (refJobs.length) {
      await save({ stage: 'references' });
      await Promise.all(refJobs.map(async (r) => {
        const prev = assets.references[r.key] || { attempts: 0 };
        try {
          const out = await images.generate({ prompt: r.prompt, aspect: r.kind === 'location' ? '9:16' : '3:4' });
          addCost(out.cost);
          assets.references[r.key] = { url: out.url, model: out.model, attempts: prev.attempts + 1 };
          if (r.kind === 'character') await logEvent(admin, p.user_id, 'character_reference_generated', {});
        } catch (e) {
          assets.references[r.key] = { ...prev, attempts: prev.attempts + 1, error: String(e.message).slice(0, 160) };
        }
      }));
      await save({ assets, cost_cents: p.cost_cents });
    }

    // 4. KEYFRAMES — each shot's first frame, generated FROM the reference images
    const kfJobs = shots.filter((s) => !assets.keyframes[s.id]?.url && (assets.keyframes[s.id]?.attempts || 0) < MAX_IMAGE_ATTEMPTS);
    if (kfJobs.length) {
      await save({ stage: 'keyframes' });
      await Promise.all(kfJobs.map(async (shot) => {
        const prev = assets.keyframes[shot.id] || { attempts: 0 };
        const req = keyframeRequest(bible, shot);
        const refUrls = req.refs.map((k) => assets.references[k]?.url).filter(Boolean);
        try {
          const out = refUrls.length
            ? await images.edit({ prompt: req.prompt, imageUrls: refUrls })
            : await images.generate({ prompt: req.prompt });
          addCost(out.cost);
          assets.keyframes[shot.id] = { url: out.url, model: out.model, refs: req.refs.filter((k) => assets.references[k]?.url), attempts: prev.attempts + 1 };
        } catch (e) {
          assets.keyframes[shot.id] = { ...prev, attempts: prev.attempts + 1, error: String(e.message).slice(0, 160) };
        }
      }));
      await save({ assets, cost_cents: p.cost_cents });
    }
    const framed = shots.filter((s) => assets.keyframes[s.id]?.url);
    if (!framed.length) throw new Error('no keyframes could be made');

    // Keep the keyframes as the dream's pictures (gallery covers, shared page, fallback film).
    if (dream.status !== 'ready' || !dream.scenes?.length) {
      const scenes = [];
      for (const s of framed) {
        const stored = await storePublicImage(admin, p.user_id, dreamId, s.id, assets.keyframes[s.id].url).catch(() => assets.keyframes[s.id].url);
        scenes.push({ caption: s.narration || s.action, image_url: stored, shot_id: s.id, image_prompt: s.visual });
      }
      await admin.from('dreams').update({ scenes, status: 'ready', title: p.storyboard.title }).eq('id', dreamId);
    }

    // 5. ANIMATING — real video clips from the keyframes (skipped when the daily budget is spent)
    let useVideo = !assets.videoSkipped;
    if (useVideo && !Object.keys(assets.clips).length && await overBudget(admin)) {
      assets.videoSkipped = 'daily budget reached';
      useVideo = false;
      await save({ assets });
    }
    if (useVideo) {
      await save({ stage: 'animating' });
      const video = videoProvider(p.tier === 'premium' ? process.env.PREMIUM_VIDEO_PROVIDER : process.env.VIDEO_PROVIDER);
      while (true) {
        let pending = 0;
        for (const shot of framed) {
          const c = assets.clips[shot.id] || { attempts: 0 };
          if (c.status === 'done' || (c.status === 'failed' && c.attempts >= MAX_SHOT_ATTEMPTS)) continue;
          const timedOut = c.status === 'pending' && Date.now() - new Date(c.submittedAt).getTime() > CLIP_TIMEOUT_MS;
          if (!c.requestId || c.status === 'failed' || timedOut) {
            if (c.attempts >= MAX_SHOT_ATTEMPTS) { assets.clips[shot.id] = { ...c, status: 'failed' }; continue; }
            const vr = videoRequest(bible, shot);
            try {
              const { requestId } = await video.submit({
                startImageUrl: assets.keyframes[shot.id].url,
                prompt: vr.prompt, negative: vr.negative, duration: vr.duration,
                elementImages: vr.elements.map((k) => assets.references[k]?.url).filter(Boolean),
              });
              addCost(video.costPerSecond * vr.duration);
              assets.clips[shot.id] = { requestId, provider: video.id, model: video.model, attempts: c.attempts + 1, status: 'pending', submittedAt: now() };
              await logEvent(admin, p.user_id, 'video_clip_started', { attempt: c.attempts + 1 });
            } catch (e) {
              assets.clips[shot.id] = { ...c, attempts: c.attempts + 1, status: 'failed', error: String(e.message).slice(0, 160) };
            }
            pending++;
            continue;
          }
          const st = await video.check(c.requestId);
          if (st.status === 'done') {
            assets.clips[shot.id] = { ...c, status: 'done', url: st.url, doneAt: now() };
            await logEvent(admin, p.user_id, 'video_clip_completed', { attempt: c.attempts });
          } else if (st.status === 'failed') {
            assets.clips[shot.id] = { ...c, status: 'failed', error: st.error };
            await logEvent(admin, p.user_id, 'video_clip_failed', { attempt: c.attempts });
            if (c.attempts < MAX_SHOT_ATTEMPTS) pending++;
          } else pending++;
        }
        await save({ assets, cost_cents: p.cost_cents });
        if (!pending) break;
        if (timeLeft() < 25_000) return 'waiting';
        await sleep(8000);
      }
    }

    // 6. VOICE — the dreamer's remembered narration, one short line per shot
    const lines = framed.map((s) => s.narration || '');
    const missingVoice = framed.filter((s, i) => lines[i] && !assets.voice[s.id] && !(assets.voiceFailed || []).includes(s.id));
    if (missingVoice.length) {
      await save({ stage: 'voice' });
      const failed = assets.voiceFailed || [];
      await Promise.all(missingVoice.map(async (s) => {
        const spoken = await speakLine(openai, s.narration);
        if (!spoken) { failed.push(s.id); return; }
        const p2 = `${p.user_id}/${dreamId}/voice-${s.id}.wav`;
        const { error } = await admin.storage.from(REEL_BUCKET).upload(p2, spoken.wav, { contentType: 'audio/wav', upsert: true });
        if (error) { failed.push(s.id); return; }
        assets.voice[s.id] = { path: p2, seconds: spoken.seconds };
        addCost(0.002);
      }));
      assets.voiceFailed = failed;
      await save({ assets, cost_cents: p.cost_cents });
    }
    if (timeLeft() < 150_000) return 'waiting'; // editing needs a clear run

    // 7. EDITING (+ 8. CHECKING) — assemble the film, check every clip first
    await save({ stage: 'editing' });
    const result = await editFilm(admin, p, framed, assets);
    if (!result) throw new Error('editing produced nothing');

    const paths = reelPaths(p.user_id, dreamId);
    const done = now();
    await admin.from('dream_reels').upsert({
      dream_id: dreamId, user_id: p.user_id, status: 'completed', stage: null,
      narration: { lines: result.lines, mood: bible.mood, source: 'director', voiced: result.voiced },
      soundtrack: result.soundtrack, video_path: paths.video, poster_path: paths.poster,
      duration_seconds: Math.round(result.seconds * 10) / 10, size_bytes: result.bytes, width: 1080, height: 1920,
      error: null, attempts: 1, started_at: p.started_at, completed_at: done, updated_at: done,
      renderer_type: result.renderer, generation_version: p.generation_version,
    }, { onConflict: 'dream_id' });
    await save({ status: 'completed', stage: null, renderer_type: result.renderer, completed_at: done, lock_until: null, assets, cost_cents: p.cost_cents, error: null });
    await logEvent(admin, p.user_id, 'reel_completed', { renderer: result.renderer, shots: result.shotCount, seconds: Math.round(result.seconds), cost_cents: p.cost_cents });
    return 'done';
  } catch (e) {
    console.error('production failed', dreamId, e);
    const attempts = (p.assets?.runFailures || 0) + 1;
    const assets = { ...(p.assets || {}), runFailures: attempts, lastError: String(e.message).slice(0, 200) };
    if (attempts >= 3) {
      await save({ status: 'failed', stage: null, error: 'We couldn\'t finish this film. Please try again later.', assets, lock_until: null });
      await releaseQuota(admin, p);
      await logEvent(admin, p.user_id, 'reel_render_failed', { stage: p.stage || 'unknown' });
      return 'done';
    }
    await save({ assets, lock_until: null });
    return 'waiting';
  } finally {
    // Hand the production back so the next worker (or a page poll) can pick it up at once.
    await admin.from('dream_productions').update({ lock_until: null }).eq('dream_id', dreamId).then(() => {}, () => {});
  }
}

/** Downloads clips/keyframes/voice, checks them, renders the film and uploads it. */
async function editFilm(admin, p, shots, assets) {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'film-'));
  await admin.from('dream_productions').update({ stage: 'checking', updated_at: now() }).eq('dream_id', p.dream_id);
  try {
    const scenes = [];
    const voices = [];
    const keptLines = [];
    let clipsUsed = 0;
    for (const s of shots) {
      const image = path.join(workDir, `${s.id}.jpg`);
      await fetchTo(assets.keyframes[s.id].url, image, 'image/', 20e6);
      let clip = null;
      let clipSeconds = null;
      const c = assets.clips[s.id];
      if (c?.status === 'done' && c.url) {
        const file = path.join(workDir, `${s.id}.mp4`);
        try {
          await fetchTo(c.url, file, 'video/', 80e6);
          const ok = await checkClip(file);
          if (ok.ok) { clip = file; clipSeconds = ok.seconds; clipsUsed++; } else assets.clips[s.id] = { ...c, status: 'rejected', error: ok.reason };
        } catch (e) { assets.clips[s.id] = { ...c, status: 'rejected', error: String(e.message).slice(0, 120) }; }
      }
      let voice = null;
      if (assets.voice[s.id]) {
        const { data } = await admin.storage.from(REEL_BUCKET).download(assets.voice[s.id].path);
        if (data) {
          const vf = path.join(workDir, `${s.id}.wav`);
          await writeFile(vf, Buffer.from(await data.arrayBuffer()));
          voice = { file: vf, seconds: assets.voice[s.id].seconds };
        }
      }
      scenes.push({ image, clip, clipSeconds });
      voices.push(voice);
      keptLines.push(s.narration || '');
    }

    // Cinematic only if most shots really moved; otherwise label it honestly as the fallback.
    const renderer = clipsUsed >= Math.max(2, Math.ceil(shots.length * 0.6)) ? 'cinematic_video' : 'image_fallback';
    if (renderer === 'image_fallback') scenes.forEach((s) => { s.clip = null; });
    await admin.from('dream_productions').update({ stage: 'editing', assets, updated_at: now() }).eq('dream_id', p.dream_id);

    const soundtrack = soundtrackFor(p.bible.mood);
    const out = await renderReel({
      workDir, scenes, voices, lines: keptLines, music: soundtrack?.file || null, fontsDir: FONTS_DIR,
      brand: { footer: BRAND.footer, title: BRAND.name, tagline: BRAND.tagline, domain: siteDomain() },
    });
    const paths = reelPaths(p.user_id, p.dream_id);
    const up = await admin.storage.from(REEL_BUCKET).upload(paths.video, await readFile(out.video), { contentType: 'video/mp4', upsert: true });
    if (up.error) throw new Error(`storage upload failed: ${up.error.message}`);
    await admin.storage.from(REEL_BUCKET).upload(paths.poster, await readFile(out.poster), { contentType: 'image/jpeg', upsert: true });
    return {
      renderer, seconds: out.seconds, bytes: out.bytes, soundtrack: soundtrack?.id || null, shotCount: shots.length,
      lines: keptLines, voiced: voices.map((v) => (v ? v.seconds : null)),
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Only fetch media from fal's CDN or our own storage.
function allowedUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && (/(^|\.)fal\.media$/.test(url.host) || url.host === 'storage.googleapis.com' || url.host.endsWith('.supabase.co'));
  } catch { return false; }
}
async function fetchTo(url, file, typePrefix, maxBytes) {
  if (!allowedUrl(url)) throw new Error('unexpected media address');
  const res = await fetch(url, { redirect: 'error' });
  if (!res.ok) throw new Error(`download ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (!type.startsWith(typePrefix) && type !== 'application/octet-stream') throw new Error(`unexpected type ${type}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error('file too large');
  await writeFile(file, buf);
}

async function storePublicImage(admin, userId, dreamId, shotId, url) {
  if (!allowedUrl(url)) return url;
  const res = await fetch(url, { redirect: 'error' });
  if (!res.ok) return url;
  const bytes = Buffer.from(await res.arrayBuffer());
  const p = `${userId}/${dreamId}/${shotId}.jpg`;
  const { error } = await admin.storage.from('reels').upload(p, bytes, { contentType: res.headers.get('content-type') || 'image/jpeg', upsert: true });
  return error ? url : admin.storage.from('reels').getPublicUrl(p).data.publicUrl;
}

/** A failed reel gives the day's slot back (at most twice a day, so retry-spam can't be abused). */
async function releaseQuota(admin, p) {
  await releaseSlot(p.quota_id);
}

export { DIRECTOR_VERSION };
