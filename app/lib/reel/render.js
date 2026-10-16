// Renders a finished Dream Reel MP4 with ffmpeg: gentle camera moves on each
// scene, cross-fades, captions, narration over ducked ambient music, a quiet
// footer and an end card. Runs on the server only.
import { spawn } from 'node:child_process';
import { writeFile, symlink, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import { planTimeline, moveFor, FPS, WIDTH, HEIGHT, CROSSFADE } from './timeline.js';
import { buildAss } from './captions.js';

const RENDER_TIMEOUT_MS = 230_000;

export function ffmpegPath() {
  return process.env.FFMPEG_PATH || ffmpegStatic;
}

/** Smooth start and stop for every camera move. */
const EASE = '(1-cos(PI*on/__N__))/2';

function kenBurns(move, frames) {
  const e = EASE.replace('__N__', String(frames));
  const cx = 'iw/2-(iw/zoom/2)';
  const cy = 'ih/2-(ih/zoom/2)';
  switch (move) {
    case 'out': return { z: `1.14-0.14*${e}`, x: cx, y: cy };
    case 'panRight': return { z: '1.12', x: `(iw-iw/zoom)*(0.15+0.7*${e})`, y: cy };
    case 'panLeft': return { z: '1.12', x: `(iw-iw/zoom)*(0.85-0.7*${e})`, y: cy };
    case 'panUp': return { z: '1.12', x: cx, y: `(ih-ih/zoom)*(0.85-0.7*${e})` };
    case 'in':
    default: return { z: `1+0.14*${e}`, x: cx, y: cy };
  }
}

/**
 * @param {object} job
 * @param {string} job.workDir      scratch folder (inputs already downloaded into it)
 * @param {Array<{image:string, clip?:string|null, clipSeconds?:number}>} job.scenes   local file paths
 * @param {Array<{file:string, seconds:number}|null>} job.voices   narration per scene (null = silent)
 * @param {string[]} job.lines      caption per scene
 * @param {string|null} job.music   local path to the soundtrack
 * @param {string} job.fontsDir     folder with the brand fonts
 * @param {{footer:string,title:string,tagline:string[],domain:string}} job.brand
 * @returns {Promise<{video:string, poster:string, seconds:number, bytes:number}>}
 */
export async function renderReel(job) {
  const { workDir, scenes, voices, lines, music, fontsDir, brand } = job;
  if (!scenes.length) throw new Error('No scenes to render');

  const timeline = planTimeline(scenes.map((_, i) => voices[i]?.seconds ?? null), {
    minSeconds: scenes.map((s) => (s.clip && s.clipSeconds ? Math.min(s.clipSeconds, 10) : 0)),
  });
  const total = timeline.total;

  // Captions file + fonts sit next to each other in the work folder, so the
  // ffmpeg filter needs no tricky absolute-path escaping.
  await writeFile(path.join(workDir, 'reel.ass'), buildAss({ timeline, lines, brand }), 'utf8');
  await symlink(fontsDir, path.join(workDir, 'fonts')).catch(async () => { await mkdir(path.join(workDir, 'fonts'), { recursive: true }); });

  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  const filters = [];
  let input = 0;

  // --- pictures / clips -------------------------------------------------
  const videoLabels = [];
  scenes.forEach((scene, i) => {
    const dur = timeline.scenes[i].duration;
    const frames = Math.round(dur * FPS);
    if (scene.clip) {
      // A real AI video shot: played once, never looped. If the narration needs longer
      // than the clip, it is slowed slightly (max 1.3×) and then holds its last frame.
      const clipSec = scene.clipSeconds || dur;
      const slow = dur > clipSec ? Math.min(1.3, dur / clipSec) : 1;
      const hold = Math.max(0, dur - clipSec * slow + 0.2);
      args.push('-i', scene.clip);
      filters.push(
        `[${input}:v]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase:flags=lanczos,crop=${WIDTH}:${HEIGHT},` +
        `setpts=${slow.toFixed(3)}*(PTS-STARTPTS),tpad=stop_mode=clone:stop_duration=${hold.toFixed(3)},` +
        `trim=duration=${dur},setpts=PTS-STARTPTS,fps=${FPS},setsar=1,format=yuv420p[v${i}]`
      );
    } else {
      args.push('-i', scene.image);
      const kb = kenBurns(moveFor(i), frames);
      // Upscale 2× first so slow moves glide instead of stepping pixel by pixel.
      filters.push(
        `[${input}:v]scale=${WIDTH * 2}:${HEIGHT * 2}:force_original_aspect_ratio=increase:flags=lanczos,crop=${WIDTH * 2}:${HEIGHT * 2},` +
        `zoompan=z='${kb.z}':x='${kb.x}':y='${kb.y}':d=${frames}:s=${WIDTH}x${HEIGHT}:fps=${FPS},setsar=1,format=yuv420p[v${i}]`
      );
    }
    videoLabels.push(`v${i}`);
    input++;
  });

  // --- end card: the last picture, softly blurred and darkened -------------
  const lastImage = scenes[scenes.length - 1].image;
  args.push('-loop', '1', '-framerate', String(FPS), '-t', String(timeline.endCard.duration + 0.5), '-i', lastImage);
  filters.push(
    `[${input}:v]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},gblur=sigma=38,` +
    `eq=brightness=-0.28:saturation=0.75,trim=duration=${timeline.endCard.duration},setpts=PTS-STARTPTS,fps=${FPS},setsar=1,format=yuv420p[vend]`
  );
  videoLabels.push('vend');
  input++;

  // --- cross-fade everything together ------------------------------------
  let prev = videoLabels[0];
  const allStarts = [...timeline.scenes.map((s) => s.start), timeline.endCard.start];
  for (let k = 1; k < videoLabels.length; k++) {
    const out = k === videoLabels.length - 1 ? 'vjoined' : `x${k}`;
    filters.push(`[${prev}][${videoLabels[k]}]xfade=transition=fade:duration=${CROSSFADE}:offset=${allStarts[k].toFixed(3)}[${out}]`);
    prev = out;
  }
  if (videoLabels.length === 1) filters.push(`[${prev}]null[vjoined]`);
  filters.push(
    `[vjoined]vignette=angle=PI/5,subtitles=reel.ass:fontsdir=fonts,` +
    `fade=t=in:st=0:d=0.8,fade=t=out:st=${(total - 0.45).toFixed(3)}:d=0.45[vout]`
  );

  // --- narration ---------------------------------------------------------
  const voiceLabels = [];
  voices.forEach((v, i) => {
    if (!v) return;
    args.push('-i', v.file);
    const ms = Math.round(timeline.scenes[i].voiceAt * 1000);
    filters.push(`[${input}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${ms}|${ms}[n${i}]`);
    voiceLabels.push(`n${i}`);
    input++;
  });

  // --- music: soft fades, ducked under the voice, loudness-normalised -----
  let musicLabel = null;
  if (music) {
    args.push('-stream_loop', '-1', '-i', music);
    filters.push(
      `[${input}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS,` +
      `volume=${voiceLabels.length ? 0.6 : 1.0},afade=t=in:st=0:d=1.8,afade=t=out:st=${Math.max(0, total - 2.6).toFixed(3)}:d=2.6[mus]`
    );
    musicLabel = 'mus';
    input++;
  }

  const master = `loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,apad=whole_dur=${total.toFixed(3)},atrim=0:${total.toFixed(3)}[aout]`;
  if (voiceLabels.length) {
    filters.push(`${voiceLabels.map((l) => `[${l}]`).join('')}amix=inputs=${voiceLabels.length}:normalize=0:duration=longest,apad=whole_dur=${total.toFixed(3)}[voice]`);
    if (musicLabel) {
      filters.push('[voice]asplit=2[vmain][vkey]');
      filters.push(`[${musicLabel}][vkey]sidechaincompress=threshold=0.025:ratio=7:attack=40:release=650:makeup=1[ducked]`);
      filters.push(`[vmain][ducked]amix=inputs=2:normalize=0:duration=first,${master}`);
    } else {
      filters.push(`[voice]${master}`);
    }
  } else if (musicLabel) {
    filters.push(`[${musicLabel}]${master}`);
  } else {
    filters.push(`anullsrc=r=48000:cl=stereo,atrim=0:${total.toFixed(3)}[aout]`);
  }

  const video = path.join(workDir, 'reel.mp4');
  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
    '-t', total.toFixed(3), '-movflags', '+faststart', video
  );
  await run(args, workDir, RENDER_TIMEOUT_MS);

  const poster = path.join(workDir, 'poster.jpg');
  await run(['-hide_banner', '-loglevel', 'error', '-y', '-ss', '1.8', '-i', video, '-frames:v', '1', '-vf', 'scale=720:-2', '-q:v', '3', poster], workDir, 30_000);

  const { size } = await stat(video);
  return { video, poster, seconds: total, bytes: size, timeline };
}

/** Runs ffmpeg; rejects with the tail of its error output on failure. */
export function run(args, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { if (err.length < 16000) err += d.toString(); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Render took too long')); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else {
        // Skip ffmpeg's generic shutdown chatter and keep the lines that explain the failure.
        const useful = err.trim().split('\n').filter((l) => !/Terminating thread|Task finished|Could not open encoder|Nothing was written/.test(l));
        reject(new Error(`ffmpeg exited with ${code}: ${useful.slice(0, 6).join(' | ')}`));
      }
    });
  });
}

/** Length of a WAV file in seconds, read from its header. */
export function wavSeconds(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  let off = 12;
  let byteRate = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') byteRate = buf.readUInt32LE(off + 16);
    if (id === 'data') {
      // Streamed WAVs may carry a placeholder size; fall back to what's actually there.
      if (size === 0 || size === 0xffffffff || off + 8 + size > buf.length) size = buf.length - off - 8;
      return byteRate ? size / byteRate : null;
    }
    off += 8 + size + (size % 2);
  }
  return null;
}
