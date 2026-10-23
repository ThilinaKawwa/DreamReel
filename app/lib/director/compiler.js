// DREAM PROMPT COMPILER
// DreamBible + one shot → provider-independent prompts. Provider adapters
// (lib/providers/*) turn these into model-specific requests. Pure functions.

import { VISUAL_STYLES } from './bible.js';

export const COMPILER_VERSION = 'compiler-2026-10-16b'; // v2 hardening: legend matches attached refs, reference packs

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

/** Prompt for one planned reference (see routing.referencePlan). Same text every time. */
export function referencePrompt(bible, ref) {
  const s = style(bible);
  if (ref.kind === 'character') {
    const c = bible.characters.find((x) => x.id === ref.id);
    if (ref.view === 'three_quarter') {
      return `The SAME person as in Image 1 — identical face, skin, hair, age, build and clothing (${c.clothing}). Turned to a three-quarter view, full body, plain light grey background, soft even light. Only one person. No text.`;
    }
    return `Character reference photograph of one fictional person (${c.role}): ${characterLock(c)}. Full body, standing, facing the camera, neutral calm expression, even soft studio light, plain light grey background, sharp focus on face and clothing. ${s}. Only one person. No text.`;
  }
  if (ref.kind === 'location') {
    const l = bible.locations.find((x) => x.id === ref.id);
    return `Establishing wide shot of ${l.name}: ${locationLock(l)}. No people. Vertical 9:16 composition. ${s}. No text.`;
  }
  const o = bible.objects.find((x) => x.id === ref.id);
  if (ref.view === 'alt') {
    return `The SAME object as in Image 1 — identical shape, size, material, colour and every detail (${o.description}). Seen from a different angle, about 45 degrees to the side, isolated on a plain neutral background, soft light, sharp detail. No text.`;
  }
  return `Close reference photo of ${o.name}: ${o.description}. Isolated on a plain neutral background, soft light, sharp detail. ${s}. No text.`;
}

/** Back-compatible: every possible reference (tests and tools). */
export function referencePrompts(bible) {
  return [
    ...bible.characters.map((c) => ({ key: `character:${c.id}`, kind: 'character', id: c.id, view: 'front' })),
    ...bible.locations.map((l) => ({ key: `location:${l.id}`, kind: 'location', id: l.id, view: 'front' })),
    ...bible.objects.map((o) => ({ key: `object:${o.id}`, kind: 'object', id: o.id, view: 'front' })),
  ].map((r) => ({ ...r, prompt: referencePrompt(bible, r) }));
}

/**
 * Keyframe = the first frame of a shot, generated FROM the reference images that exist
 * (`available`), so people, places and objects keep their identity. The legend numbers
 * match the images actually attached; anything without a reference is described in words.
 */
export function keyframeRequest(bible, shot, available = null) {
  const has = (k) => (available ? available.has(k) : true);
  const loc = bible.locations.find((l) => l.id === shot.locationId) || bible.locations[0];
  const chars = shot.characterIds.map((id) => bible.characters.find((c) => c.id === id)).filter(Boolean);
  const objs = shot.objectIds.map((id) => bible.objects.find((o) => o.id === id)).filter(Boolean);

  const refs = [];
  const legend = [];
  const described = [];
  for (const c of chars) {
    const k = `character:${c.id}`;
    if (has(k)) { refs.push(k); legend.push(`Image ${refs.length} shows ${c.role} — keep exactly the same face, hair, age, build and clothing (${c.clothing}).`); }
    else described.push(`${c.role}: ${characterLock(c)}.`);
  }
  const lk = `location:${loc.id}`;
  if (has(lk)) { refs.push(lk); legend.push(`Image ${refs.length} shows the place (${loc.name}) — keep its architecture, colours and light.`); }
  else described.push(`Place: ${loc.name} — ${locationLock(loc)}.`);
  for (const o of objs) {
    const k = `object:${o.id}`;
    if (has(k)) { refs.push(k); legend.push(`Image ${refs.length} shows ${o.name} — keep it identical.`); }
    else described.push(`${o.name}: ${o.description}.`);
  }
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
      described.join(' '),
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
    labels: Object.fromEntries([
      ...chars.map((c) => [`character:${c.id}`, `${c.role} (${c.clothing})`]),
      ...shot.objectIds.map((id) => bible.objects.find((o) => o.id === id)).filter(Boolean).map((o) => [`object:${o.id}`, o.name]),
    ]),
    duration: shot.duration,
  };
}
