// End-to-end render check, fully offline: builds 5 test pictures and 5 test "voice"
// tones, renders a real Dream Reel with the real music and fonts, and verifies the MP4.
// Run: npm run test:render   (takes ~30–60 s)
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { renderReel, run, ffmpegPath, wavSeconds } from '../lib/reel/render.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = await mkdtemp(path.join(os.tmpdir(), 'reel-smoke-'));
try {
  const colors = ['0x1b1446', '0x2a1660', '0x3d1c5c', '0x10243f', '0x22104a'];
  const scenes = [];
  const voices = [];
  for (let i = 0; i < 5; i++) {
    const image = path.join(dir, `img-${i}.jpg`);
    await run(['-y', '-f', 'lavfi', '-i', `gradients=s=576x1024:c0=${colors[i]}:c1=0xf5b544:n=2:speed=0`, '-frames:v', '1', image], dir, 30_000);
    const voice = path.join(dir, `voice-${i}.wav`);
    await run(['-y', '-f', 'lavfi', '-i', `sine=f=${220 + i * 40}:d=${3 + i * 0.4}`, '-ar', '24000', '-ac', '1', voice], dir, 30_000);
    scenes.push({ image });
    voices.push({ file: voice, seconds: wavSeconds(await readFile(voice)) });
  }

  const t0 = Date.now();
  const out = await renderReel({
    workDir: dir,
    scenes,
    voices,
    lines: ['I stood beside a silent ocean.', 'The water rose into the sky.', 'Stars drifted past my hands.', 'A door glowed in the sand.', 'And then I woke.'],
    music: path.join(root, 'assets/music/dreamy.m4a'),
    fontsDir: path.join(root, 'assets/fonts'),
    brand: { footer: 'Dream Reel', title: 'Dream Reel', tagline: ['Dreams disappear.', 'Keep yours.'], domain: 'dreamreel.app' },
  });
  const ms = Date.now() - t0;

  const info = spawnSync(ffmpegPath(), ['-hide_banner', '-i', out.video], { encoding: 'utf8' }).stderr;
  const dur = info.match(/Duration: (\d+):(\d+):([\d.]+)/);
  const seconds = Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]);
  assert.match(info, /Video: h264 .*1080x1920/, 'H.264 1080×1920');
  assert.match(info, /Audio: aac .*48000 Hz, stereo/, 'AAC stereo audio');
  assert.ok(Math.abs(seconds - out.seconds) < 0.25, `duration ${seconds}s vs planned ${out.seconds}s`);
  assert.ok(seconds >= 15 && seconds <= 35, `${seconds}s within 15–35 s`);
  assert.ok(out.bytes > 500_000 && out.bytes < 40_000_000, `size ${out.bytes}`);
  assert.ok((await readFile(out.poster)).length > 5_000, 'poster image');
  console.log(`PASS render smoke: ${seconds.toFixed(1)} s film, ${(out.bytes / 1e6).toFixed(1)} MB, rendered in ${(ms / 1000).toFixed(1)} s`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
