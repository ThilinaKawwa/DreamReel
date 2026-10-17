import { models } from '../models.js';
// DREAM DIRECTOR — step 2: plan the film.
// Turns the DreamBible into 3–6 shots using real film grammar: one clear motion
// idea per shot, every shot pointing at fixed character/location/object IDs.
// Also writes the narration in the dreamer's own remembering voice.

export const STORYBOARD_PROMPT_VERSION = 'storyboard-2026-10-16b';
export const SHOT_SECONDS = 5; // the video model's native clip length

const SHOT_TYPES = ['establishing wide', 'wide', 'medium', 'close-up', 'extreme close-up', 'over-the-shoulder', 'pov', 'insert'];
const CAMERA_MOVES = ['static', 'slow push in', 'slow pull back', 'tracking', 'handheld follow', 'slow pan', 'tilt up', 'crane up', 'orbit'];

// Words that make narration sound machine-written. A line containing any of them is rewritten from the dreamer's own words.
export const PURPLE_WORDS = [
  'ethereal', 'celestial', 'majestic', 'majestically', 'tapestry', 'symphony', 'whisper of', 'beckon', 'beckoned', 'transcend',
  'enigmatic', 'otherworldly', 'mesmerizing', 'mesmerising', 'surreal dance', 'cascade of', 'kaleidoscope', 'embrace of',
  'boundless', 'infinite expanse', 'heavens', 'realm', 'tranquil', 'serene', 'luminous', 'gossamer', 'reverie', 'ascended',
  'ventured', 'torrent', 'unstoppable', 'consumed the', 'engulfed', 'shadowed', 'beneath an', 'veil of', 'tendrils',
  'cascading', 'shimmering', 'glistening', 'whispered secrets', 'in that moment', 'little did', 'destiny', 'fate itself',
  'surrendered', 'swallowed the', 'the world around', 'eternity', 'dreamscape', 'otherworld', 'ethereally', 'majesty',
];

// Phrases that turn a memory into a trailer. Checked as patterns, not single words.
const TRAILER_PATTERNS = [
  /\b(as|while) (an?|the) \w+ \w+ (consumed|engulfed|swallowed)/i,
  /\bthe laws of (nature|physics)\b/i,
  /\b(i|we) found (myself|ourselves)\b/i,   // classic AI opener
  /\bsuddenly,? the world\b/i,
  /\bnothing would ever be the same\b/i,
];

export function storyboardSystem(bible, { maxShots }) {
  return `You are the director and editor of a short vertical film (9:16) recreating someone's dream for them.
You have the DreamBible below. Plan between 3 and ${maxShots} shots — fewer, better shots beat many weak ones. Each shot becomes one ${SHOT_SECONDS}-second AI video clip.

Film grammar:
- Open with an establishing shot of the first place. Follow the chronology; do not reorder events.
- Choose framing per shot from: ${SHOT_TYPES.join(', ')}.
- Choose ONE camera move per shot from: ${CAMERA_MOVES.join(', ')}. Use "static" or "slow push in" often; save energetic moves for moments that need them.
- Each shot has exactly ONE clear motion idea the video model must animate (e.g. "water rises upward", "brother turns and runs toward the stairs", "the black door swings open"). Never several complicated actions at once.
- Dreamer mode is "${bible.dreamer.mode}". ${bible.dreamer.mode === 'pov' ? 'Use POV or show only the dreamer\'s hands/feet; never show the dreamer\'s face.' : 'The dreamer may appear, always matching their description.'}
- Only use character/location/object IDs that exist in the bible. List every character and object visible in the shot.

Narration ("narration") — this is the most important writing rule:
- It is the dreamer quietly remembering, first person, past tense, plain everyday words, like telling a friend over coffee.
- Keep their own phrases, their uncertainty ("I think", "it was sort of…") and their reactions ("I remember just staring at it").
- 5 to 14 words per shot. Some shots may have no narration (empty string) — silence is fine.
- NEVER: poetic or trailer language, metaphors they didn't use, "I found myself", words like ${PURPLE_WORDS.slice(0, 14).join(', ')}.
- Do not tidy away their personality: keep "like", "sort of", "I think" where they used them.
  GOOD: "I was standing by the ocean, and then the water just started rising into the sky."
  GOOD: "I remember walking through the station with my brother. He still had his red jacket on."
  BAD: "Beneath an endless celestial horizon, the ocean ascended majestically toward the heavens."
  BAD: "My brother and I ventured through the shadowed station as an unstoppable torrent consumed the world around us."

Return JSON only:
{ "title": string (2–5 plain words),
  "shots": [{
    "id": "shot_01",
    "locationId": string, "characterIds": string[], "objectIds": string[],
    "shotType": string, "camera": string,
    "visual": string,          // what we see in the first frame: composition, who is where, key props — concrete
    "action": string,          // the ONE motion idea
    "lighting": string, "mood": string,
    "transition": "cut" | "dissolve",
    "sound": string,           // ambient sound idea, e.g. "distant traffic, wind"
    "narration": string
  }]
}`;
}

const str = (v, max = 300) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** True if a narration line sounds machine-written. */
export function soundsWritten(line) {
  const l = ` ${String(line || '').toLowerCase()} `;
  return PURPLE_WORDS.some((w) => l.includes(` ${w}`))
    || TRAILER_PATTERNS.some((re) => re.test(l))
    || (l.match(/,/g) || []).length > 3;
}

/** Plain fallback narration: the dreamer's own cleaned sentences, shortened, spread over the shots. */
export function plainNarration(cleanedDream, count) {
  const sentences = String(cleanedDream || '').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < count; i++) {
    const s = sentences[Math.floor((i * sentences.length) / Math.max(count, 1))] || '';
    const words = s.split(/\s+/).slice(0, 16).join(' ');
    out.push(words && !/[.!?]$/.test(words) ? `${words}…` : words);
  }
  return out;
}

/** Validates the storyboard against the bible. Unknown IDs are dropped; broken shots removed. */
export function normalizeStoryboard(raw, bible, { maxShots }) {
  const ids = {
    c: new Set(bible.characters.map((c) => c.id)),
    l: new Set(bible.locations.map((l) => l.id)),
    o: new Set(bible.objects.map((o) => o.id)),
  };
  const shots = (Array.isArray(raw?.shots) ? raw.shots : []).slice(0, maxShots).map((s, i) => ({
    id: `shot_${String(i + 1).padStart(2, '0')}`,
    locationId: ids.l.has(s.locationId) ? s.locationId : bible.locations[0].id,
    characterIds: (Array.isArray(s.characterIds) ? s.characterIds : []).filter((x) => ids.c.has(x)).slice(0, 3),
    objectIds: (Array.isArray(s.objectIds) ? s.objectIds : []).filter((x) => ids.o.has(x)).slice(0, 3),
    shotType: SHOT_TYPES.includes(s.shotType) ? s.shotType : 'wide',
    camera: CAMERA_MOVES.includes(s.camera) ? s.camera : 'slow push in',
    visual: str(s.visual, 500),
    action: str(s.action, 200),
    lighting: str(s.lighting, 160),
    mood: str(s.mood, 60),
    transition: s.transition === 'dissolve' ? 'dissolve' : 'cut',
    sound: str(s.sound, 120),
    narration: str(s.narration, 160),
    duration: SHOT_SECONDS,
  })).filter((s) => s.visual && s.action);
  if (shots.length < 2) throw new Error('Storyboard: too few usable shots');

  // Narration guard: machine-sounding lines are replaced by the dreamer's own words.
  const plain = plainNarration(bible.cleanedDream || bible.originalTranscript, shots.length);
  let replaced = 0;
  shots.forEach((s, i) => {
    if (s.narration && (soundsWritten(s.narration) || s.narration.split(/\s+/).length > 18)) { s.narration = plain[i]; replaced++; }
  });
  return { title: str(raw?.title, 60) || 'Last night', promptVersion: STORYBOARD_PROMPT_VERSION, shots, narrationReplaced: replaced };
}

export async function buildStoryboard(openai, bible, { maxShots = 5, model = models().director } = {}) {
  let lastErr;
  const bibleForModel = { ...bible, originalTranscript: undefined };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const completion = await openai.chat.completions.create({
        model,
        temperature: 0.5,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: storyboardSystem(bible, { maxShots }) },
          { role: 'user', content: `DreamBible:\n${JSON.stringify(bibleForModel)}\n\nThe dreamer's own words (for narration voice):\n"""${String(bible.originalTranscript).slice(0, 6000)}"""` },
        ],
      });
      return normalizeStoryboard(JSON.parse(completion.choices[0].message.content || '{}'), bible, { maxShots });
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}
