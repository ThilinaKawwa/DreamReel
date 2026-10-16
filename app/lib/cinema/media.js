// PRIVATE media for Dream Director. Bucket `dream-media` has no storage policies, so
// only the server (service role) can touch it. Paths are always rebuilt here from the
// owner's id and the dream id — a path from a browser is never used.
export const MEDIA_BUCKET = 'dream-media';

const SAFE = /^[a-z0-9_:.-]{1,80}$/i;

export function mediaPath(userId, dreamId, name) {
  if (!/^[0-9a-f-]{36}$/i.test(userId) || !/^[0-9a-f-]{36}$/i.test(dreamId) || !SAFE.test(name) || name.includes('..')) {
    throw new Error('bad media path');
  }
  return `${userId}/${dreamId}/${name.replace(/:/g, '_')}`;
}

/** True only for paths inside this owner's dream folder. */
export function ownsPath(path, userId, dreamId) {
  return typeof path === 'string' && path.startsWith(`${userId}/${dreamId}/`) && !path.includes('..');
}

// Only fetch generated media from fal's CDN.
export function allowedProviderUrl(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== 'https:') return false;
    if (/(^|\.)fal\.media$/.test(url.host)) return true;
    return url.host === 'storage.googleapis.com' && url.pathname.startsWith('/falserverless/');
  } catch { return false; }
}

/** Copies a provider result into private storage. Returns { path, bytes, type }. */
export async function storeFromProvider(admin, path, url, typePrefix, maxBytes) {
  if (!allowedProviderUrl(url)) throw new Error('unexpected media address');
  const res = await fetch(url, { redirect: 'error' });
  if (!res.ok) throw new Error(`download ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (!type.startsWith(typePrefix)) throw new Error(`unexpected type ${type}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error('file too large');
  const { error } = await admin.storage.from(MEDIA_BUCKET).upload(path, buf, { contentType: type.split(';')[0], upsert: true });
  if (error) throw new Error(`storage upload failed: ${error.message}`);
  return { path, bytes: buf, type };
}

export async function storeBytes(admin, path, bytes, contentType) {
  const { error } = await admin.storage.from(MEDIA_BUCKET).upload(path, bytes, { contentType, upsert: true });
  if (error) throw new Error(`storage upload failed: ${error.message}`);
  return path;
}

export async function readBytes(admin, path) {
  const { data, error } = await admin.storage.from(MEDIA_BUCKET).download(path);
  if (error || !data) throw new Error(`storage read failed: ${error?.message || 'missing'}`);
  return Buffer.from(await data.arrayBuffer());
}

/** Short-lived link. Used for provider inputs (the model must fetch our reference) and for owners. */
export async function signedUrl(admin, path, seconds, opts) {
  const { data, error } = await admin.storage.from(MEDIA_BUCKET).createSignedUrl(path, seconds, opts);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}
