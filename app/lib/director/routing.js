// Decides, per dream and per shot, which references are worth generating and which
// video mode to use. Pure functions — no model IDs here (those live in lib/providers).
//
// Principle: continuity first, cost second.
//   • A person or object that appears in 2+ shots is IDENTITY-CRITICAL.
//   • Identity shots use the reference-conditioned video mode (Kling O1 "elements").
//   • Scenic shots (no recurring person/object) use first-frame image-to-video (Kling 2.5).

/** How many shots each character / location / object appears in. */
export function usage(storyboard) {
  const n = { character: {}, location: {}, object: {} };
  for (const s of storyboard.shots) {
    n.location[s.locationId] = (n.location[s.locationId] || 0) + 1;
    for (const c of s.characterIds) n.character[c] = (n.character[c] || 0) + 1;
    for (const o of s.objectIds) n.object[o] = (n.object[o] || 0) + 1;
  }
  return n;
}

/**
 * The smallest useful set of canonical references:
 *   every on-screen character → front view; recurring characters → + three-quarter view
 *   recurring locations (2+ shots) → one establishing reference
 *   recurring objects (2+ shots) → one reference
 * One-off places/objects are described in the keyframe prompt instead (saves calls).
 */
export function referencePlan(bible, storyboard) {
  const u = usage(storyboard);
  const plan = [];
  for (const c of bible.characters) {
    if (!u.character[c.id]) continue;
    plan.push({ key: `character:${c.id}`, kind: 'character', id: c.id, view: 'front' });
    if (u.character[c.id] >= 2) plan.push({ key: `character:${c.id}:three_quarter`, kind: 'character', id: c.id, view: 'three_quarter', from: `character:${c.id}` });
  }
  for (const l of bible.locations) if ((u.location[l.id] || 0) >= 2) plan.push({ key: `location:${l.id}`, kind: 'location', id: l.id, view: 'front' });
  for (const o of bible.objects) if ((u.object[o.id] || 0) >= 2) plan.push({ key: `object:${o.id}`, kind: 'object', id: o.id, view: 'front' });
  return plan;
}

/** Video mode for one shot: 'identity' (reference-conditioned) or 'scenic' (first-frame i2v). */
export function routeShot(storyboard, shot, env = process.env) {
  const u = usage(storyboard);
  const people = shot.characterIds.filter((c) => (u.character[c] || 0) >= 2);
  const things = shot.objectIds.filter((o) => (u.object[o] || 0) >= 2);
  const identityKeys = [...people.map((c) => `character:${c}`), ...things.map((o) => `object:${o}`)].slice(0, 3);
  if (identityKeys.length && env.IDENTITY_ROUTING !== 'off') {
    return { mode: 'identity', provider: env.IDENTITY_VIDEO_PROVIDER || 'kling-o1-ref', identityKeys };
  }
  return { mode: 'scenic', provider: env.SCENIC_VIDEO_PROVIDER || 'kling-i2v', identityKeys: [] };
}
