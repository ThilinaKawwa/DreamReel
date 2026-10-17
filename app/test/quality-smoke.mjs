// Runs the real clip checker on three generated clips: moving, frozen, black.
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../lib/reel/render.js';
import { checkClip } from '../lib/cinema/quality.js';

const dir = await mkdtemp(path.join(os.tmpdir(), 'qc-'));
const make = (name, src) => run(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', src, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(dir, name)], dir, 60_000);
await make('moving.mp4', 'testsrc2=s=576x1024:d=5');
await run(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=576x1024:d=0.1', '-vf', 'tpad=stop_mode=clone:stop_duration=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(dir, 'still.mp4')], dir, 60_000);
await make('black.mp4', 'color=c=black:s=576x1024:d=5');
const results = {};
for (const f of ['moving.mp4', 'still.mp4', 'black.mp4']) results[f] = await checkClip(path.join(dir, f));
console.log(results);
if (!results['moving.mp4'].ok || results['still.mp4'].ok || results['black.mp4'].ok) { console.error('FAIL'); process.exit(1); }
console.log('quality smoke: PASS');
