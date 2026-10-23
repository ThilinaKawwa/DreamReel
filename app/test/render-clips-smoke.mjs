// Cinematic edit check, fully offline: 4 synthetic 5-second "AI clips" (one deliberately
// short, to exercise the hold-last-frame path), narration tones, real music + fonts.
// Verifies the clips play once (no looping) and the film is a valid 1080×1920 MP4.
// Run: node test/render-clips-smoke.mjs
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { renderReel, run, ffmpegPath, wavSeconds } from '../lib/reel/render.js';
import { checkClip } from '../lib/cinema/quality.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = await mkdtemp(path.join(os.tmpdir(), 'clips-smoke-'));
try {
  const scenes = [];
  const voices = [];
  const lens = [5, 5, 3, 5];
  for (let i = 0; i < lens.length; i++) {
    const clip = path.join(dir, `clip-${i}.mp4`);
    await run(['-y', '-f', 'lavfi', '-i', `testsrc2=s=720x1280:r=24:d=${lens[i]}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip], dir, 60_000);
    const image = path.join(dir, `kf-${i}.jpg`);
    await run(['-y', '-i', clip, '-frames:v', '1', image], dir, 30_000);
    const q = await checkClip(clip);
    assert.ok(q.ok, `clip ${i} passes quality: ${q.reason}`);
    scenes.push({ image, clip, clipSeconds: q.seconds });
    const voice = path.join(dir, `voice-${i}.wav`);
    await run(['-y', '-f', 'lavfi', '-i', `sine=f=${240 + i * 40}:d=${i === 2 ? 4.4 : 2.6}`, '-ar', '24000', '-ac', '1', voice], dir, 30_000);
    voices.push({ file: voice, seconds: wavSeconds(await readFile(voice)) });
  }
  const t0 = Date.now();
  const out = await renderReel({
    workDir: dir, scenes, voices,
    lines: ['I was at home, but it was sort of a station.', 'My brother kept running up the stairs.', 'They just kept getting longer.', 'Then he turned round, and he looked younger.'],
    music: path.join(root, 'assets/music/nostalgic.m4a'),
    fontsDir: path.join(root, 'assets/fonts'),
    brand: { footer: 'Dream Reel', title: 'Dream Reel', tagline: ['Dreams disappear.', 'Keep yours.'], domain: 'dreamreel.app' },
  });
  const ms = Date.now() - t0;
  const info = spawnSync(ffmpegPath(), ['-hide_banner', '-i', out.video], { encoding: 'utf8' }).stderr;
  const dur = info.match(/Duration: (\d+):(\d+):([\d.]+)/);
  const seconds = Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]);
  assert.match(info, /Video: h264 .*1080x1920/);
  assert.ok(Math.abs(seconds - out.seconds) < 0.25, `duration ${seconds} vs ${out.seconds}`);
  out.timeline.scenes.forEach((s, i) => assert.ok(s.duration >= Math.min(lens[i], 5) - 0.01, `scene ${i} shows its whole clip`));
  const q = await checkClip(out.video);
  assert.ok(q.ok, `finished film passes quality: ${q.reason}`);
  console.log(`PASS clips smoke: ${seconds.toFixed(1)} s film from ${lens.length} clips, ${(out.bytes / 1e6).toFixed(1)} MB, rendered in ${(ms / 1000).toFixed(1)} s`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
