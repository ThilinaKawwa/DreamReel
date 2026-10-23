import { createClient } from '@supabase/supabase-js';

// These two values are safe to be public (they only allow what the
// database security rules allow). Override with env vars if you ever
// move to a different Supabase project.
export const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://srhtouxfjrpfllocrarg.supabase.co';
export const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'sb_publishable_4WxgMv9OSdbzb5LqGv61Ng_W2qdpuQB';

let browserClient;
let signupPromise = null; // two components asking at once must not create two accounts

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
  if (!signupPromise) {
    signupPromise = (async () => {
      const { data: anon, error } = await supabase.auth.signInAnonymously();
      if (error) throw error;
      // Funnel: a new visitor's account now exists. (Behaviour only — no personal data.)
      const uid = anon.session.user.id;
      supabase.from('analytics_events').insert([
        { user_id: uid, event: 'signup_started', props: {}, source: 'web' },
        { user_id: uid, event: 'signup_completed', props: { anonymous: true }, source: 'web' },
      ]).then(() => {}, () => {});
      return anon.session;
    })().finally(() => { signupPromise = null; });
  }
  return signupPromise;
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
