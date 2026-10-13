import OpenAI from 'openai';
import { json, requireUser, getProfile, isPremium } from '@/lib/server';
import { speak, plainForSpeech } from '@/lib/guru';

export const maxDuration = 60;
export const runtime = 'nodejs';

/** Reads one of the Guru's own words aloud (the reading or a chat answer). Premium only. */
export async function POST(req) {
  const auth = await requireUser(req);
  if (!auth) return json({ error: 'Not signed in.' }, 401);
  if (!isPremium(await getProfile(auth.supabase, auth.user.id))) return json({ error: 'Premium only.', upgrade: true }, 402);

  const { dreamId, messageId } = await req.json().catch(() => ({}));
  // Only speak text the Guru actually wrote for this person — never arbitrary input.
  let text = '';
  if (messageId) {
    const { data } = await auth.supabase.from('guru_messages').select('content, role').eq('id', messageId).maybeSingle();
    if (data?.role === 'assistant') text = data.content;
  } else if (dreamId) {
    const { data } = await auth.supabase.from('dream_readings').select('reading').eq('dream_id', dreamId).maybeSingle();
    text = data?.reading || '';
  }
  if (!text) return json({ error: 'Nothing to read.' }, 404);

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const mp3 = await speak(openai, plainForSpeech(text));
    return new Response(mp3, { headers: { 'content-type': 'audio/mpeg', 'cache-control': 'private, max-age=86400' } });
  } catch (e) {
    console.error('speak failed', e?.message || e);
    return json({ error: 'Could not find his voice just now.' }, 502);
  }
}
