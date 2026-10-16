// Automatic checks on every generated clip before it goes into a film.
// "The API returned 200" is not success: the file must exist, decode, last long
// enough and actually show something.
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { ffmpegPath } from '../reel/render.js';

export const MIN_CLIP_SECONDS = 1.5;

/** Runs ffmpeg and returns its log (it reports analysis results on stderr). */
function probe(args, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let log = '';
    child.stderr.on('data', (d) => { if (log.length < 200_000) log += d.toString(); });
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, log }); });
    child.on('error', () => { clearTimeout(t); resolve({ code: -1, log }); });
  });
}

/** Pure: reads ffmpeg's analysis log. Exported for tests. */
export function judgeClipLog(code, log) {
  if (code !== 0) return { ok: false, reason: 'clip does not decode' };
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(log);
  const seconds = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0;
  if (!/Stream #\d+:\d+.*: Video:/.test(log)) return { ok: false, reason: 'no video stream' };
  if (seconds < MIN_CLIP_SECONDS) return { ok: false, reason: `too short (${seconds.toFixed(1)}s)`, seconds };
  const black = [...log.matchAll(/black_duration:(\d+(?:\.\d+)?)/g)].reduce((n, m) => n + Number(m[1]), 0);
  if (black > seconds * 0.5) return { ok: false, reason: 'mostly black', seconds };
  // freezedetect reports freeze_start / freeze_end; a freeze lasting to the end has no end line.
  let frozen = 0;
  let from = null;
  for (const m of log.matchAll(/\[freezedetect[^\]]*\] lavfi\.freezedetect\.freeze_(start|end): (\d+(?:\.\d+)?)/g)) {
    if (m[1] === 'start') from = Number(m[2]);
    else if (from !== null) { frozen += Number(m[2]) - from; from = null; }
  }
  if (from !== null) frozen += seconds - from;
  if (frozen > seconds * 0.8) return { ok: false, reason: 'no movement', seconds };
  return { ok: true, seconds };
}

/** @returns {Promise<{ok:boolean, reason?:string, seconds?:number}>} */
export async function checkClip(file) {
  const s = await stat(file).catch(() => null);
  if (!s || s.size < 4_000) return { ok: false, reason: 'missing or empty file' };
  const { code, log } = await probe([
    '-hide_banner', '-i', file, '-an',
    '-vf', 'blackdetect=d=0.4:pix_th=0.08,freezedetect=n=0.002:d=1',
    '-f', 'null', '-',
  ]);
  return judgeClipLog(code, log);
}
