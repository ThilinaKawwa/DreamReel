// Helpers used only by API routes (never imported by the browser).
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, getUserSupabase } from '@/lib/supabase';

export function json(body, status = 200) {
  return Response.json(body, { status });
}

/**
 * Reads the login token the browser sends and returns { user, supabase }
 * where `supabase` acts as that user (database security rules apply).
 * Returns null when the request isn't signed in.
 */
export async function requireUser(req) {
  const auth = req.headers.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const supabase = getUserSupabase(token);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return { user: data.user, supabase };
}

/**
 * Server-only client that bypasses security rules. Needed by the Stripe
 * webhook to mark people as Premium. Requires SUPABASE_SERVICE_ROLE_KEY.
 */
export function getServiceSupabase() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  return createClient(SUPABASE_URL, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

const ACTIVE = new Set(['active', 'trialing']);

/** The person's plan row (or a free default if they have never paid). */
export async function getProfile(supabase, userId) {
  const { data } = await supabase.from('profiles').select('*').eq('user_id', userId).maybeSingle();
  return data || { user_id: userId, plan: 'free', guru_tradition: 'blend' };
}

export function isPremium(profile) {
  if (!profile || profile.plan !== 'premium' || !ACTIVE.has(profile.subscription_status)) return false;
  // A small grace window so a renewal that's a few minutes late doesn't lock anyone out.
  if (profile.current_period_end && new Date(profile.current_period_end).getTime() < Date.now() - 36 * 3600 * 1000) return false;
  return true;
}

/** Downloads a file from a URL and keeps a permanent copy in our `reels` storage bucket. */
export async function storeFromUrl(supabase, path, sourceUrl, fallbackType = 'application/octet-stream') {
  const res = await fetch(sourceUrl);
  if (!res.ok) throw new Error(`Could not download ${sourceUrl} (${res.status})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  return storeBytes(supabase, path, bytes, res.headers.get('content-type') || fallbackType);
}

export async function storeBytes(supabase, path, bytes, contentType) {
  const { error } = await supabase.storage.from('reels').upload(path, bytes, { contentType, upsert: true });
  if (error) throw error;
  return supabase.storage.from('reels').getPublicUrl(path).data.publicUrl;
}
