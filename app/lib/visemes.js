// APPROXIMATE viseme lip sync for Orin — no extra service, no heavy binary.
// The reply text is turned into a sequence of mouth shapes with English spelling rules,
// spread over the real length of the spoken audio (longer for vowels, pauses at
// punctuation). In the browser the live loudness of the voice then decides how open
// each shape is, so the mouth closes in silences. Labelled "approximate": it is not
// phoneme-aligned and not studio-grade lip sync.

/** Mouth shapes: how open, how wide, how rounded; MBP presses the lips, FV tucks the lip. */
export const VISEMES = {
  rest: { open: 0, width: 1, round: 0 },
  A: { open: 1, width: 1.05, round: 0 },
  E: { open: 0.5, width: 1.2, round: 0 },
  O: { open: 0.75, width: 0.72, round: 1 },
  MBP: { open: 0, width: 0.95, round: 0, press: 1 },
  FV: { open: 0.15, width: 1.05, round: 0, tuck: 1 },
  L: { open: 0.45, width: 1, round: 0 },
  wide: { open: 0.3, width: 1.32, round: 0 },
};

const DIGRAPHS = [
  ['ee', 'wide'], ['ea', 'wide'], ['oo', 'O'], ['ou', 'O'], ['ow', 'O'], ['oa', 'O'], ['aw', 'O'],
  ['th', 'L'], ['sh', 'wide'], ['ch', 'wide'], ['ph', 'FV'], ['wh', 'O'], ['qu', 'O'], ['ng', 'L'],
];
const LETTERS = {
  a: 'A', e: 'E', i: 'E', o: 'O', u: 'O', y: 'E', w: 'O',
  m: 'MBP', b: 'MBP', p: 'MBP', f: 'FV', v: 'FV',
  l: 'L', n: 'L', t: 'L', d: 'L',
  s: 'wide', z: 'wide', c: 'wide', x: 'wide', j: 'wide', g: 'wide', k: 'wide', q: 'wide', r: 'L', h: 'rest',
};
const VOWELISH = new Set(['A', 'E', 'O', 'wide']);

/** Shapes for one word (silent final "e" dropped, repeats merged). */
export function wordVisemes(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '').replace(/([^aeiou])e$/, '$1');
  const out = [];
  for (let i = 0; i < w.length;) {
    const two = DIGRAPHS.find(([d]) => w.startsWith(d, i));
    const v = two ? two[1] : LETTERS[w[i]] || 'rest';
    i += two ? 2 : 1;
    if (out[out.length - 1] !== v) out.push(v);
  }
  return out;
}

/**
 * @param {string} text      what Orin says
 * @param {number} duration  length of the audio in seconds
 * @returns {Array<{t:number, v:string}>}  shape changes over time, starting at 0
 */
export function textToVisemes(text, duration) {
  const tokens = String(text || '').replace(/[*_#>`]/g, ' ').match(/[A-Za-z']+|[.,!?;:—-]/g) || [];
  const units = [];
  for (const tok of tokens) {
    if (/^[.!?]$/.test(tok)) units.push({ v: 'rest', w: 2.2 });
    else if (/^[,;:—-]$/.test(tok)) units.push({ v: 'rest', w: 1.1 });
    else {
      for (const v of wordVisemes(tok)) units.push({ v, w: VOWELISH.has(v) ? 1.3 : 0.75 });
      units.push({ v: 'rest', w: 0.25 }); // tiny gap between words
    }
  }
  const total = units.reduce((a, u) => a + u.w, 0);
  if (!total || !(duration > 0)) return [{ t: 0, v: 'rest' }];
  const scale = duration / total;
  const track = [];
  let t = 0;
  for (const u of units) {
    if (track[track.length - 1]?.v !== u.v) track.push({ t: Math.round(t * 1000) / 1000, v: u.v });
    t += u.w * scale;
  }
  track.push({ t: Math.round(duration * 1000) / 1000, v: 'rest' });
  return track;
}

/** Shape at time t (binary search). */
export function visemeAt(track, t) {
  if (!track?.length || t < 0) return 'rest';
  let lo = 0, hi = track.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (track[mid].t <= t) lo = mid; else hi = mid - 1;
  }
  return track[lo].v;
}
