'use client';
// Funnel analytics from the browser. Fire-and-forget: never blocks or breaks the app.
import { getBrowserSupabase } from '@/lib/supabase';
import { EVENTS, safeProps } from '@/lib/events';

const once = new Set();

export async function track(event, props, { onceKey } = {}) {
  if (!EVENTS.includes(event)) return;
  if (onceKey) { if (once.has(onceKey)) return; once.add(onceKey); }
  try {
    const supabase = getBrowserSupabase();
    const { data } = await supabase.auth.getSession();
    const uid = data.session?.user?.id;
    if (!uid) return;
    await supabase.from('analytics_events').insert({ user_id: uid, event, props: safeProps(props), source: 'web' });
  } catch {}
}

/** Counts a "return session" when someone comes back after 30+ minutes away. */
export function noteVisit() {
  try {
    const now = Date.now();
    const last = Number(localStorage.getItem('dreamreel.lastSeen') || 0);
    localStorage.setItem('dreamreel.lastSeen', String(now));
    if (last && now - last > 30 * 60 * 1000) track('return_session', { hours_away: Math.round((now - last) / 36e5) });
  } catch {}
}
