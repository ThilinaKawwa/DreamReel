import OpenAI from 'openai';
import { json, requireUser, getProfile } from '@/lib/server';
import { getEntitlements } from '@/lib/entitlements';
import { GURU_MODEL, readingSystemPrompt, dreamNotes, memoryNotes, loadMemory, tradition } from '@/lib/guru';

export const maxDuration = 60;
export const runtime = 'nodejs';

/** The Guru's first reading of a dream. Made once, then kept. Premium only. */
export async function POST(req) {
  const auth = await requireUser(req);
  if (!auth) return json({ error: 'Not signed in.' }, 401);
  const { user, supabase } = auth;

  const { dreamId } = await req.json().catch(() => ({}));
  if (!/^[0-9a-f-]{36}$/i.test(dreamId || '')) return json({ error: 'Which dream?' }, 400);

  // Access is decided on the server from the plan the Stripe webhook wrote — never from the request.
  if (!(await getEntitlements(supabase, user.id)).canUseGuruReading) return json({ error: 'The Guru is part of Premium.', upgrade: true }, 402);
  const { data: existing } = await supabase.from('dream_readings').select('*').eq('dream_id', dreamId).maybeSingle();
  if (existing) return json({ reading: existing });

  const profile = await getProfile(supabase, user.id);

  const { data: dream } = await supabase.from('dreams').select('*').eq('id', dreamId).eq('user_id', user.id).maybeSingle();
  if (!dream || dream.status !== 'ready') return json({ error: 'That dream is not ready yet.' }, 404);

  const lens = tradition(profile.guru_tradition);
  const memory = await loadMemory(supabase, user.id, dreamId);
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  let parsed;
  try {
    const completion = await openai.chat.completions.create({
      model: GURU_MODEL,
      temperature: 0.85,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: readingSystemPrompt(lens) },
        { role: 'user', content: `${dreamNotes(dream)}\n\n${memoryNotes(memory)}` },
      ],
    });
    parsed = JSON.parse(completion.choices[0].message.content || '{}');
    if (!parsed.reading || !parsed.summary) throw new Error('Incomplete reading');
  } catch (e) {
    console.error('reading failed', e);
    return json({ error: 'The Guru is gathering his thoughts. Try again in a moment.' }, 502);
  }

  const list = (v) => (Array.isArray(v) ? v.map(String).slice(0, 6) : []);
  const row = {
    dream_id: dreamId,
    user_id: user.id,
    reading: String(parsed.reading),
    summary: String(parsed.summary).slice(0, 280),
    symbols: list(parsed.symbols),
    themes: list(parsed.themes),
    emotions: list(parsed.emotions),
    tradition: lens,
  };
  const { data: saved, error } = await supabase.from('dream_readings').insert(row).select().single();
  if (error) {
    // Two taps at once: the other request already saved it.
    const { data: again } = await supabase.from('dream_readings').select('*').eq('dream_id', dreamId).maybeSingle();
    if (again) return json({ reading: again });
    console.error('saving reading failed', error);
    return json({ error: 'Could not save the reading.' }, 500);
  }
  return json({ reading: saved });
}
