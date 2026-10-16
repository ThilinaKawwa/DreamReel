import OpenAI from 'openai';
import { json, requireUser, getProfile } from '@/lib/server';
import { logEvent } from '@/lib/analytics-server';
import { transcriptionProvider } from '@/lib/audio/transcription';
import { underLimit } from '@/lib/ratelimit';
import { expressionFor, EXPRESSIONS, parseGuruReply as parseReply } from '@/lib/guru-expression';
import { getEntitlements } from '@/lib/entitlements';
import {
  GURU_MODEL, GURU_DAILY_MESSAGES, chatSystemPrompt, dreamNotes, memoryNotes, loadMemory,
  tradition, speak, plainForSpeech,
} from '@/lib/guru';

export const maxDuration = 60;
export const runtime = 'nodejs';

/**
 * One turn of conversation with the Guru about a dream.
 * Send multipart form: dreamId, and either `text` or `audio` (a voice note).
 * If the question was spoken (or `speak=1`), the answer comes back as audio too.
 */
export async function POST(req) {
  const auth = await requireUser(req);
  if (!auth) return json({ error: 'Not signed in.' }, 401);
  const { user, supabase } = auth;

  // Access is decided on the server from the plan the Stripe webhook wrote — never from the request.
  if (!(await getEntitlements(supabase, user.id)).canUseGuru) return json({ error: 'The Guru is part of Premium.', upgrade: true }, 402);
  const profile = await getProfile(supabase, user.id);

  const form = await req.formData();
  const dreamId = String(form.get('dreamId') || '');
  if (!/^[0-9a-f-]{36}$/i.test(dreamId)) return json({ error: 'Which dream?' }, 400);
  const audio = form.get('audio');
  const viaVoice = Boolean(audio && typeof audio === 'object' && audio.size > 0);
  const wantsAudio = viaVoice || form.get('speak') === '1';

  if (!(await underLimit(user.id, 'guruChat'))) return json({ error: 'Let’s pause for a little while — you can ask again soon.' }, 429);
  if (viaVoice && !(await underLimit(user.id, 'guruVoice'))) return json({ error: 'Let’s pause the voice for a little while — you can still type.' }, 429);

  // Fair-use cap per day
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count } = await supabase
    .from('guru_messages')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .eq('role', 'user')
    .gte('created_at', since);
  if ((count || 0) >= GURU_DAILY_MESSAGES) {
    return json({ error: `The Guru rests now. You've asked ${GURU_DAILY_MESSAGES} questions today — return tomorrow.` }, 429);
  }

  const { data: dream } = await supabase.from('dreams').select('*').eq('id', dreamId).eq('user_id', user.id).maybeSingle();
  if (!dream) return json({ error: 'Dream not found.' }, 404);
  const { data: reading } = await supabase.from('dream_readings').select('*').eq('dream_id', dreamId).maybeSingle();

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // What did they say?
  let question = String(form.get('text') || '').trim().slice(0, 1500);
  if (viaVoice) {
    try {
      const t = await transcriptionProvider(openai).transcribe(audio, { prompt: 'Someone asking a wise dream interpreter about their dream.' });
      question = t.text.slice(0, 1500);
    } catch (e) {
      console.error('guru transcription failed', e);
      return json({ error: "I couldn't hear that clearly. Try again, a little closer to the phone." }, 400);
    }
  }
  if (!question) return json({ error: 'Ask the Guru something about your dream.' }, 400);

  const { data: history } = await supabase
    .from('guru_messages')
    .select('role, content')
    .eq('dream_id', dreamId)
    .order('created_at', { ascending: false })
    .limit(20);
  const memory = await loadMemory(supabase, user.id, dreamId, 10);

  const context = [
    dreamNotes(dream),
    reading ? `Your first reading of this dream:\n${reading.reading}` : '',
    memoryNotes(memory),
  ].filter(Boolean).join('\n\n');

  let answer;
  let expression = null;
  try {
    const completion = await openai.chat.completions.create({
      model: GURU_MODEL,
      temperature: 0.8,
      max_tokens: wantsAudio ? 260 : 460,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `${chatSystemPrompt(tradition(profile.guru_tradition), { voice: wantsAudio })}\n\n${context}\n\n${EXPRESSION_RULE}` },
        ...(history || []).reverse().map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: question },
      ],
    });
    const parsed = parseReply(completion.choices[0].message.content);
    answer = parsed.text;
    expression = parsed.expression;
    if (!answer) throw new Error('Empty answer');
  } catch (e) {
    console.error('guru chat failed', e);
    return json({ error: 'The Guru is quiet for a moment. Please ask again.' }, 502);
  }

  // Two separate inserts so each gets its own timestamp and the order stays right.
  const { error: qErr } = await supabase.from('guru_messages')
    .insert({ dream_id: dreamId, user_id: user.id, role: 'user', content: question, via_voice: viaVoice });
  const { data: saved, error: aErr } = await supabase.from('guru_messages')
    .insert({ dream_id: dreamId, user_id: user.id, role: 'assistant', content: answer, via_voice: wantsAudio })
    .select('id').single();
  if (qErr || aErr) console.error('saving guru messages failed', qErr || aErr);

  let audioB64 = null;
  if (wantsAudio) {
    try {
      audioB64 = (await speak(openai, plainForSpeech(answer))).toString('base64');
    } catch (e) {
      console.error('guru speech failed', e?.message || e);
    }
  }

  // Behaviour only — never the question or the answer.
  await logEvent(supabase, user.id, 'guru_response_completed', { voice: viaVoice, spoken: Boolean(audioB64) });
  if (viaVoice) await logEvent(supabase, user.id, 'guru_voice_started', {});
  return json({ question, answer, messageId: saved?.id || null, audio: audioB64, audioType: 'audio/wav', expression: expression || expressionFor(answer) });
}

// The model picks Orin's face for the reply from a fixed list (no extra AI call).
const EXPRESSION_RULE = `Reply ONLY as JSON: {"text": your reply exactly as you would say it, "expression": one of ${JSON.stringify(EXPRESSIONS)}}.
Choose the expression that fits the reply's tone. Prefer "warm", "thoughtful" or "curious"; use "concerned" for painful topics; "amused" and "surprised" rarely.`;
