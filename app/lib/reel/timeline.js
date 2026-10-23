// Works out when every scene, line of narration and caption happens.
// Pure maths — no files, no network — so it is easy to test.

export const FPS = 30;
export const WIDTH = 1080;
export const HEIGHT = 1920;
export const CROSSFADE = 0.8; // seconds between scenes
export const END_CARD = 2.6; // "Dream Reel · Dreams disappear. Keep yours."
export const VOICE_LEAD = 0.55; // pause after a scene appears before its line is spoken
export const SILENT_SCENE = 4.6; // scene length when there is no narration
export const MIN_SCENE = 3.4;
export const MAX_SCENE = 8.5;

const round = (x) => Math.round(x * 1000) / 1000;

/**
 * @param {Array<number|null>} voiceSeconds  length of each scene's spoken line (null = silent)
 * @param {{minSeconds?: number[]}} [opts]   per-scene minimum (e.g. the length of its video clip)
 * @returns {{ scenes: Array<{start:number, duration:number, voiceAt:number|null, captionStart:number, captionEnd:number}>,
 *             endCard: {start:number, duration:number}, total:number }}
 */
export function planTimeline(voiceSeconds, { minSeconds = [] } = {}) {
  const scenes = [];
  let start = 0;
  voiceSeconds.forEach((voice, i) => {
    const hasVoice = typeof voice === 'number' && voice > 0;
    // Long enough to say the line, breathe, and cross-fade into the next scene without overlap.
    const needed = hasVoice ? voice + VOICE_LEAD + CROSSFADE + 0.35 : SILENT_SCENE;
    // Real video clips set a floor: a 5-second shot is shown in full, not cut short.
    const floor = Math.max(MIN_SCENE, minSeconds[i] || 0);
    const duration = round(Math.min(Math.max(needed, floor), Math.max(MAX_SCENE, needed, floor)));
    const lead = i === 0 ? VOICE_LEAD + 0.25 : VOICE_LEAD; // first line waits for the fade from black
    scenes.push({
      start: round(start),
      duration,
      voiceAt: hasVoice ? round(start + lead) : null,
      captionStart: round(start + (i === 0 ? 0.6 : 0.35)),
      captionEnd: round(start + duration - CROSSFADE * 0.6),
    });
    start += duration - CROSSFADE;
  });
  const endCard = { start: round(start), duration: END_CARD };
  return { scenes, endCard, total: round(start + END_CARD) };
}

/** Each scene gets a different, gentle camera move so the reel never feels like a slideshow. */
export const MOVES = ['in', 'panRight', 'out', 'panUp', 'panLeft'];
export function moveFor(index) {
  return MOVES[index % MOVES.length];
}
