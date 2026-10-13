'use client';
// Browser helpers for calling our own API with the visitor's login.
import { ensureSession } from '@/lib/supabase';

export async function api(path, { method = 'POST', json, form } = {}) {
  const session = await ensureSession();
  const headers = { Authorization: `Bearer ${session.access_token}` };
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form;
  const res = await fetch(path, { method, headers, body });
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json().catch(() => ({})) : await res.blob();
  if (!res.ok) {
    const err = new Error((isJson && data.error) || 'Something went wrong.');
    err.status = res.status;
    err.upgrade = isJson && data.upgrade;
    throw err;
  }
  return data;
}

/** Sends people to Stripe to start Premium. */
export async function startPremium(returnTo = window.location.pathname) {
  const { url } = await api('/api/billing/checkout', { json: { returnTo } });
  window.location.href = url;
}

export function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  const c = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return c.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

/** Plays MP3 bytes (base64 or Blob). Returns the Audio element so callers can stop it. */
export function playAudio(src) {
  const url = typeof src === 'string' ? `data:audio/mpeg;base64,${src}` : URL.createObjectURL(src);
  const a = new Audio(url);
  a.play().catch(() => {});
  return a;
}
