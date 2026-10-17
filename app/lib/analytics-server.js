import { EVENTS, safeProps } from '@/lib/events';

/** Records a funnel event from the server as the signed-in person. Never throws. */
export async function logEvent(supabase, userId, event, props) {
  if (!EVENTS.includes(event)) return;
  try {
    const { error } = await supabase.from('analytics_events').insert({ user_id: userId, event, props: safeProps(props), source: 'server' });
    if (error && !/relation .* does not exist|schema cache/i.test(error.message)) console.error('analytics', error.message);
  } catch {}
}
