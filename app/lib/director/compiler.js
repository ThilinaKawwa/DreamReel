// DREAM PROMPT COMPILER
// DreamBible + one shot → provider-independent prompts. Provider adapters
// (lib/providers/*) turn these into model-specific requests. Pure functions.

import { VISUAL_STYLES } from './bible.js';

export const COMPILER_VERSION = 'compiler-2026-10-17';

export const NEGATIVE = [
  'text', 'letters', 'watermark', 'logo', 'subtitles', 'extra people', 'duplicate person', 'extra limbs',
  'deformed hands', 'face morphing', 'identity change', 'outfit change', 'sudden location change', 'cartoon', 'low quality',
];

const style = (bible) => VISUAL_STYLES[bible.visualStyle] || VISUAL_STYLES.surreal_realism;

/** The locked description of a character. Identical text every time it is used. */
export function characterLock(c) {
  return [
    c.age && `${c.age}`, c.genderPresentation, c.face && `face: ${c.face}`, c.hair && `hair: ${c.hair}`,
    c.build && `build: ${c.build}`, c.clothing && `wearing ${c.clothing}`, c.accessories && `with ${c.accessories}`,
  ].filter(Boolean).join('; ');
}

export function locationLock(l) {
  return [l.architecture, l.environment, l.landmarks && `landmarks: ${l.landmarks}`, l.timeOfDay, l.lighting, l.weather, l.palette && `palette: ${l.palette}`]
    .filter(Boolean).join('; ');
}

/** Prompts for the canonical reference images (made once per dream, reused for every shot). */
export function referencePrompts(bible) {
  const s = style(bible);
  return [
    ...bible.characters.map((c) => ({
      key: `character:${c.id}`, kind: 'character', id: c.id,
      prompt: `Character reference photograph of one fictional person (${c.role}): ${characterLock(c)}. Full body, standing, facing the camera at a slight three-quarter angle, neutral calm expression, even soft studio light, plain light grey background, sharp focus on face and clothing. ${s}. Only one person. No text.`,
    })),
    ...bible.locations.map((l) => ({
      key: `location:${l.id}`, kind: 'location', id: l.id,
      prompt: `Establishing wide shot of ${l.name}: ${locationLock(l)}. No people. Vertical 9:16 composition. ${s}. No text.`,
    })),
    ...bible.objects.map((o) => ({
      key: `object:${o.id}`, kind: 'object', id: o.id,
      prompt: `Close reference photo of ${o.name}: ${o.description}. Isolated on a plain neutral background, soft light, sharp detail. ${s}. No text.`,
    })),
  ];
}

/**
 * Keyframe = the first frame of a shot, generated FROM the reference images so
 * people, places and objects keep their identity. Returns the ordered list of
 * reference keys the provider must attach, and a prompt that names each one.
 */
export function keyframeRequest(bible, shot) {
  const loc = bible.locations.find((l) => l.id === shot.locationId) || bible.locations[0];
  const chars = shot.characterIds.map((id) => bible.characters.find((c) => c.id === id)).filter(Boolean);
  const objs = shot.objectIds.map((id) => bible.objects.find((o) => o.id === id)).filter(Boolean);

  const refs = [...chars.map((c) => `character:${c.id}`), `location:${loc.id}`, ...objs.map((o) => `object:${o.id}`)];
  const legend = [
    ...chars.map((c, i) => `Image ${i + 1} shows ${c.role} — keep exactly the same face, hair, age, build and clothing (${c.clothing}).`),
    `Image ${chars.length + 1} shows the place (${loc.name}) — keep its architecture, colours and light.`,
    ...objs.map((o, i) => `Image ${chars.length + 2 + i} shows ${o.name} — keep it identical.`),
  ];
  const pov = bible.dreamer.mode === 'pov' && /pov/i.test(shot.shotType)
    ? 'Seen from the dreamer\'s own eyes (first-person POV); the dreamer\'s face is never shown.' : '';
  const rules = bible.continuityRules.filter((r) => [loc.id, ...shot.characterIds, ...shot.objectIds].some((id) => r.includes(id))).slice(0, 4);

  return {
    refs,
    prompt: [
      `A single cinematic film frame, vertical 9:16. ${shot.shotType} shot.`,
      shot.visual, pov,
      `Lighting: ${shot.lighting || loc.lighting}. Mood: ${shot.mood}.`,
      legend.join(' '),
      rules.length ? `Continuity: ${rules.join(' ')}` : '',
      `Only the people listed — no extra people. ${style(bible)}. No text, no watermark.`,
    ].filter(Boolean).join(' '),
  };
}

/** Motion prompt for image-to-video: one action, one camera move, identity held. */
export function videoRequest(bible, shot) {
  const chars = shot.characterIds.map((id) => bible.characters.find((c) => c.id === id)).filter(Boolean);
  const hold = chars.length
    ? `Keep ${chars.map((c) => `${c.role} (${c.clothing})`).join(' and ')} exactly as in the first frame — same face, hair and clothes throughout.`
    : 'Keep the scene exactly as in the first frame.';
  return {
    prompt: `${shot.action}. Camera: ${shot.camera}. ${hold} Natural, physically believable motion, cinematic, smooth. Mood: ${shot.mood}.`.slice(0, 900),
    negative: NEGATIVE.join(', '),
    elements: chars.map((c) => `character:${c.id}`), // used by providers that accept identity references
    duration: shot.duration,
  };
}
