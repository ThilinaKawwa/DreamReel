// Turns a finished dream into its Dream Reel film and saves it.
// Each stage is recorded in `dream_reels` so the page can show real progress.
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import OpenAI from 'openai';
import { SUPABASE_URL } from '@/lib/supabase';
import { BRAND, siteDomain } from '@/lib/brand';
import { writeNarration } from './narration.js';
import { speakLine } from './voice.js';
import { renderReel } from './render.js';
import { soundtrackFor, FONTS_DIR } from './assets.js';
import { logEvent } from '@/lib/analytics-server';

export const REEL_BUCKET = 'dream-videos';
export const MAX_SCENES = 8;

/** Every file for a dream lives under the owner's own folder; never trust stored paths. */
export function reelPaths(userId, dreamId) {
  const base = `${userId}/${dreamId}`;
  return {
    video: `${base}/reel.mp4`,
    poster: `${base}/poster.jpg`,
    voice: (i) => `${base}/voice-${i}.wav`,
  };
}

// Only fetch media we created: our own Supabase storage or fal.ai's CDN.
const ALLOWED_HOSTS = [new URL(SUPABASE_URL).host, 'fal.media', 'v3.fal.media', 'v2.fal.media', 'storage.googleapis.com'];
function allowedMediaUrl(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== 'https:') return false;
    return ALLOWED_HOSTS.some((h) => url.host === h || url.host.endsWith('.fal.media')) &&
      (url.host !== 'storage.googleapis.com' || url.pathname.startsWith('/falserverless/'));
  } catch {
    return false;
  }
}

async function download(url, file, { maxBytes, kind }) {
  if (!allowedMediaUrl(url)) throw new Error(`Refusing to fetch ${kind} from an unexpected address`);
  const res = await fetch(url, { redirect: 'error' });
  if (!res.ok) throw new Error(`Could not download ${kind} (${res.status})`);
  const type = res.headers.get('content-type') || '';
  if (!type.startsWith(kind === 'clip' ? 'video/' : 'image/')) throw new Error(`Unexpected ${kind} type ${type}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`${kind} too large`);
  await writeFile(file, buf);
  return file;
}

/** Friendly words for the page; the technical detail stays in the server logs. */
function friendlyError(e) {
  const m = String(e?.message || e);
  if (/too long/i.test(m)) return 'Your reel took too long to finish. Please try again.';
  if (/download|fetch|address|type|large/i.test(m)) return "We couldn't gather your dream's pictures. Please try again.";
  if (/storage|upload|bucket|row-level/i.test(m)) return "Your reel was made but couldn't be saved. Please try again.";
  return 'Something went wrong while making your reel. Please try again.';
}

/**
 * @param {object} p
 * @param {import('@supabase/supabase-js').SupabaseClient} p.supabase  acts as the owner
 * @param {string} p.userId
 * @param {string} p.dreamId
 */
export async function runReel({ supabase, userId, dreamId }) {
  const started = Date.now();
  const paths = reelPaths(userId, dreamId);
  const setStage = (stage, extra = {}) =>
    supabase.from('dream_reels')
      .update({ status: 'processing', stage, updated_at: new Date().toISOString(), ...extra })
      .eq('dream_id', dreamId).eq('user_id', userId);

  let workDir;
  try {
    const { data: dream } = await supabase.from('dreams').select('*').eq('id', dreamId).eq('user_id', userId).maybeSingle();
    if (!dream || dream.status !== 'ready' || !dream.scenes?.length) throw new Error('Dream is not ready');
    const scenes = dream.scenes.slice(0, MAX_SCENES);
    const { data: reel } = await supabase.from('dream_reels').select('*').eq('dream_id', dreamId).maybeSingle();
    const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

    workDir = await mkdtemp(path.join(os.tmpdir(), 'reel-'));

    // 1. Narration words (kept from an earlier attempt if we have them)
    await setStage('writing');
    let narration = reel?.narration?.lines?.length === scenes.length ? reel.narration : null;
    if (!narration) {
      const n = await writeNarration(openai, { ...dream, scenes });
      narration = { lines: n.lines, mood: n.mood, source: n.source, voiced: [] };
    }

    // 2. The voice — each line saved, so a retry never pays for speech twice
    await setStage('voice', { narration });
    const voices = [];
    const voiced = [];
    for (let i = 0; i < scenes.length; i++) {
      const file = path.join(workDir, `voice-${i}.wav`);
      let got = null;
      if (narration.voiced?.[i]) {
        const { data } = await supabase.storage.from(REEL_BUCKET).download(paths.voice(i));
        if (data) {
          const wav = Buffer.from(await data.arrayBuffer());
          await writeFile(file, wav);
          got = { file, seconds: narration.voiced[i] };
        }
      }
      if (!got && narration.lines[i]) {
        const spoken = await speakLine(openai, narration.lines[i]);
        if (spoken) {
          await writeFile(file, spoken.wav);
          const { error } = await supabase.storage.from(REEL_BUCKET)
            .upload(paths.voice(i), spoken.wav, { contentType: 'audio/wav', upsert: true });
          if (error) console.error('saving narration failed', error.message);
          got = { file, seconds: spoken.seconds };
        }
      }
      voices.push(got);
      voiced.push(got ? Math.round(got.seconds * 1000) / 1000 : null);
    }
    narration = { ...narration, voiced };

    // 3. Pictures (or Premium moving clips)
    await setStage('animating', { narration });
    const media = await Promise.all(scenes.map(async (s, i) => {
      const image = await download(s.image_url, path.join(workDir, `scene-${i}.img`), { maxBytes: 15e6, kind: 'image' });
      let clip = null;
      if (s.video_url) {
        clip = await download(s.video_url, path.join(workDir, `clip-${i}.mp4`), { maxBytes: 60e6, kind: 'clip' })
          .catch((e) => { console.error('clip skipped', e.message); return null; });
      }
      return { image, clip };
    }));

    // 4. Render
    await setStage('finishing');
    const soundtrack = soundtrackFor(narration.mood);
    const out = await renderReel({
      workDir,
      scenes: media,
      voices,
      lines: narration.lines,
      music: soundtrack?.file || null,
      fontsDir: FONTS_DIR,
      brand: { footer: BRAND.footer, title: BRAND.name, tagline: BRAND.tagline, domain: siteDomain() },
    });

    // 5. Save
    await setStage('saving');
    const up1 = await supabase.storage.from(REEL_BUCKET)
      .upload(paths.video, await readFile(out.video), { contentType: 'video/mp4', upsert: true, cacheControl: '31536000' });
    if (up1.error) throw new Error(`storage upload failed: ${up1.error.message}`);
    const up2 = await supabase.storage.from(REEL_BUCKET)
      .upload(paths.poster, await readFile(out.poster), { contentType: 'image/jpeg', upsert: true, cacheControl: '31536000' });
    if (up2.error) console.error('poster upload failed', up2.error.message);

    const now = new Date().toISOString();
    await supabase.from('dream_reels').update({
      status: 'completed',
      stage: null,
      narration,
      soundtrack: soundtrack?.id || null,
      video_path: paths.video,
      poster_path: up2.error ? null : paths.poster,
      duration_seconds: Math.round(out.seconds * 10) / 10,
      size_bytes: out.bytes,
      width: 1080,
      height: 1920,
      error: null,
      completed_at: now,
      updated_at: now,
    }).eq('dream_id', dreamId).eq('user_id', userId);

    await logEvent(supabase, userId, 'reel_render_completed', {
      seconds: Math.round(out.seconds), render_ms: Date.now() - started,
      narrated: voices.filter(Boolean).length, scenes: scenes.length, mood: soundtrack?.id || 'none',
    });
  } catch (e) {
    console.error('reel render failed', dreamId, e);
    await supabase.from('dream_reels').update({
      status: 'failed', stage: null, error: friendlyError(e), updated_at: new Date().toISOString(),
    }).eq('dream_id', dreamId).eq('user_id', userId);
    await logEvent(supabase, userId, 'reel_render_failed', { render_ms: Date.now() - started });
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
