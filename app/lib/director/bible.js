// DREAM DIRECTOR — step 1: understand the dream.
// Turns messy spoken words into a DreamBible: a structured, persistent record of
// who and what is in the dream, so every later shot draws from the same facts.
// The dreamer's original words are always kept untouched.

export const DIRECTOR_VERSION = 'dream-director-v2';
export const BIBLE_PROMPT_VERSION = 'bible-2026-10-17';

export const VISUAL_STYLES = {
  cinematic_realism: 'cinematic realism, natural light, shallow depth of field, 35mm film look, true-to-life textures',
  surreal_realism: 'photographic surrealism, realistic materials and light with impossible events, subtle film grain',
  nostalgic_film: 'nostalgic 1990s film photography, warm faded colour, soft grain, gentle halation',
  dreamlike_fantasy: 'painterly cinematic fantasy, luminous atmosphere, rich but restrained colour',
  psychological_mystery: 'moody psychological thriller look, low-key lighting, deep shadows, muted cold palette',
};

export const BIBLE_SYSTEM = `You are the Dream Director for Dream Reel. Someone has just woken up and spoken about their dream, messily — with pauses, repetition, corrections, "like", "sort of", "I think".
Your job is to UNDERSTAND the dream and record it faithfully as structured data. You do NOT make it more exciting.

Rules:
- Never invent major characters, events, places or objects. Only what they said, or what is clearly implied.
- When they correct themselves ("it was a cat — no, a fox"), keep the correction.
- Unimportant visual gaps (exact hair colour of a stranger, wall colour) may be filled with ONE reasonable, plain choice — and that choice then becomes fixed.
- Keep uncertainty they expressed ("somewhere like London but not exactly").
- People they know (brother, mum, a friend) are shown as fictional look-alikes, never as a real person's likeness.
- The dreamer: if they only describe what they saw, use first-person POV and never show their face. Only make them a visible character if they describe seeing themselves.
- Choose ONE visual style key from: ${Object.keys(VISUAL_STYLES).join(', ')}. Default to cinematic_realism or surreal_realism; use fantasy only if the dream itself is fantastical.

Return JSON only, exactly this shape:
{
  "cleanedDream": string,          // what happened, clearly, in their own plain words, first person, past tense
  "dreamSummary": string,          // one sentence, internal
  "emotionalArc": string[],        // 2–4 feelings in order, e.g. ["calm","strange","frightened","awe"]
  "mood": one of ["dreamy","mysterious","peaceful","cosmic","unsettling","nostalgic"],
  "visualStyle": string,           // one key from the list
  "dreamer": { "mode": "pov" | "visible", "description": string|null },  // description only if visible
  "characters": [{
    "id": string,                  // snake_case + _01, e.g. "brother_01"
    "role": string,                // e.g. "the dreamer's older brother"
    "relationship": string,
    "age": string|null,            // e.g. "late 20s" — only if said or safely implied
    "genderPresentation": string|null,
    "face": string,                // concrete: face shape, skin tone, eyes, distinctive features
    "hair": string,
    "build": string,
    "clothing": string,            // concrete and complete (colour, garment, material)
    "accessories": string|null,
    "emotionalState": string,
    "appearanceChanges": string|null  // ONLY if the dream itself says they changed
  }],
  "locations": [{
    "id": string,                  // e.g. "old_station_01"
    "name": string,
    "architecture": string,
    "environment": string,
    "timeOfDay": string,
    "lighting": string,
    "weather": string,
    "landmarks": string,
    "palette": string,
    "spatialNotes": string         // how it connects to other places in the dream
  }],
  "objects": [{ "id": string, "name": string, "description": string, "owner": string|null }],
  "chronology": [{ "step": number, "event": string, "locationId": string, "characterIds": string[], "objectIds": string[] }],
  "continuityRules": string[]      // explicit, e.g. "brother_01 wears the same red jacket in every shot"
}`;

const str = (v, max = 400) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const strOrNull = (v, max) => { const s = str(v, max); return s || null; };
const slugId = (v, fallback) => {
  const s = String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return s || fallback;
};
const MOODS = ['dreamy', 'mysterious', 'peaceful', 'cosmic', 'unsettling', 'nostalgic'];

/**
 * Validates and tidies the model's answer into a DreamBible. Throws if it is unusable.
 * IDs are made unique and every cross-reference is checked, so later stages can trust them.
 */
export function normalizeBible(raw, originalTranscript) {
  if (!raw || typeof raw !== 'object') throw new Error('Bible: not an object');
  const uniq = (list, prefix) => {
    const seen = new Set();
    return list.map((x, i) => {
      let id = slugId(x.id, `${prefix}_${String(i + 1).padStart(2, '0')}`);
      while (seen.has(id)) id = `${id}_b`;
      seen.add(id);
      return { ...x, id };
    });
  };

  const characters = uniq((Array.isArray(raw.characters) ? raw.characters : []).slice(0, 6), 'person').map((c) => ({
    id: c.id,
    role: str(c.role, 120) || 'a person in the dream',
    relationship: str(c.relationship, 120),
    age: strOrNull(c.age, 40),
    genderPresentation: strOrNull(c.genderPresentation, 40),
    face: str(c.face, 300),
    hair: str(c.hair, 160),
    build: str(c.build, 120),
    clothing: str(c.clothing, 300),
    accessories: strOrNull(c.accessories, 200),
    emotionalState: str(c.emotionalState, 120),
    appearanceChanges: strOrNull(c.appearanceChanges, 200),
  }));
  const locations = uniq((Array.isArray(raw.locations) ? raw.locations : []).slice(0, 5), 'place').map((l) => ({
    id: l.id,
    name: str(l.name, 80) || 'a place in the dream',
    architecture: str(l.architecture, 300),
    environment: str(l.environment, 300),
    timeOfDay: str(l.timeOfDay, 60),
    lighting: str(l.lighting, 160),
    weather: str(l.weather, 80),
    landmarks: str(l.landmarks, 200),
    palette: str(l.palette, 120),
    spatialNotes: str(l.spatialNotes, 200),
  }));
  if (!locations.length) throw new Error('Bible: no locations');
  const objects = uniq((Array.isArray(raw.objects) ? raw.objects : []).slice(0, 6), 'object').map((o) => ({
    id: o.id, name: str(o.name, 60), description: str(o.description, 240), owner: strOrNull(o.owner, 60),
  }));

  const ids = { c: new Set(characters.map((c) => c.id)), l: new Set(locations.map((l) => l.id)), o: new Set(objects.map((o) => o.id)) };
  const chronology = (Array.isArray(raw.chronology) ? raw.chronology : []).slice(0, 12).map((s, i) => ({
    step: i + 1,
    event: str(s.event, 300),
    locationId: ids.l.has(slugId(s.locationId)) ? slugId(s.locationId) : locations[0].id,
    characterIds: (Array.isArray(s.characterIds) ? s.characterIds : []).map((x) => slugId(x)).filter((x) => ids.c.has(x)),
    objectIds: (Array.isArray(s.objectIds) ? s.objectIds : []).map((x) => slugId(x)).filter((x) => ids.o.has(x)),
  })).filter((s) => s.event);
  if (!chronology.length) throw new Error('Bible: no chronology');

  const dreamer = raw.dreamer && raw.dreamer.mode === 'visible'
    ? { mode: 'visible', description: strOrNull(raw.dreamer.description, 300) }
    : { mode: 'pov', description: null };

  return {
    version: DIRECTOR_VERSION,
    promptVersion: BIBLE_PROMPT_VERSION,
    originalTranscript: String(originalTranscript || ''), // never altered
    cleanedDream: str(raw.cleanedDream, 3000),
    dreamSummary: str(raw.dreamSummary, 300),
    emotionalArc: (Array.isArray(raw.emotionalArc) ? raw.emotionalArc : []).map((e) => str(e, 30)).filter(Boolean).slice(0, 5),
    mood: MOODS.includes(raw.mood) ? raw.mood : 'dreamy',
    visualStyle: VISUAL_STYLES[raw.visualStyle] ? raw.visualStyle : 'surreal_realism',
    dreamer,
    characters,
    locations,
    objects,
    chronology,
    continuityRules: (Array.isArray(raw.continuityRules) ? raw.continuityRules : []).map((r) => str(r, 200)).filter(Boolean).slice(0, 15),
  };
}

/** Calls the model and returns a validated DreamBible. One retry on a malformed answer. */
export async function buildDreamBible(openai, transcript, { model = process.env.DIRECTOR_MODEL || 'gpt-4.1' } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const completion = await openai.chat.completions.create({
        model,
        temperature: 0.3,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: BIBLE_SYSTEM },
          { role: 'user', content: `The dreamer said (transcribed speech, untouched):\n"""${String(transcript).slice(0, 12000)}"""` },
        ],
      });
      return normalizeBible(JSON.parse(completion.choices[0].message.content || '{}'), transcript);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}
