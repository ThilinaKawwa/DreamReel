// Turns private scene paths into short-lived signed links — ONLY after the caller has
// established that the viewer may see this dream (owner, or the owner made it public).
import { getServiceSupabase } from '@/lib/server';
import { MEDIA_BUCKET, ownsPath } from '@/lib/cinema/media';

export const SCENE_LINK_SECONDS = 60 * 60;
export const KEYFRAME = /\/kf-shot_\d{2}\.jpg$/;

export async function signScenes(dream, seconds = SCENE_LINK_SECONDS) {
  const scenes = Array.isArray(dream?.scenes) ? dream.scenes : [];
  // Only this dream's keyframe pictures — never its film or audio, even if a row was edited
  // (owners can edit their dream row, so a stored path is checked, not trusted).
  const paths = scenes.map((s) => (s?.image_path && ownsPath(s.image_path, dream.user_id, dream.id) && KEYFRAME.test(s.image_path) ? s.image_path : null));
  if (!paths.some(Boolean)) return scenes;
  let admin;
  try { admin = getServiceSupabase(); } catch { return scenes.map((s) => ({ ...s, image_path: undefined })); }
  const wanted = paths.filter(Boolean);
  const { data } = await admin.storage.from(MEDIA_BUCKET).createSignedUrls(wanted, seconds);
  const byPath = Object.fromEntries((data || []).filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl]));
  // The private path itself is never sent to the browser.
  return scenes.map((s, i) => {
    const { image_path, ...rest } = s || {};
    return paths[i] ? { ...rest, image_url: byPath[paths[i]] || null } : rest;
  });
}
