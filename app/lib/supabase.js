import { createClient } from '@supabase/supabase-js';

// These two values are safe to be public (they only allow what the
// database security rules allow). Override with env vars if you ever
// move to a different Supabase project.
export const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://srhtouxfjrpfllocrarg.supabase.co';
export const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'sb_publishable_4WxgMv9OSdbzb5LqGv61Ng_W2qdpuQB';

let browserClient;

/** Client for use in the browser (remembers the login in localStorage). */
export function getBrowserSupabase() {
  if (!browserClient) {
    browserClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return browserClient;
}

/**
 * Makes sure the visitor has an account. New visitors get an anonymous
 * account instantly (no email needed). Returns the session.
 */
export async function ensureSession() {
  const supabase = getBrowserSupabase();
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session;
  const { data: anon, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  return anon.session;
}

/** Server-side client that acts AS the logged-in user (security rules apply). */
export function getUserSupabase(accessToken) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Server-side client with no user (can only read public dreams). */
export function getPublicSupabase() {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
