import OpenAI from 'openai';
import { after } from 'next/server';
import { json, requireUser, getProfile, getServiceSupabase } from '@/lib/server';
import { logEvent } from '@/lib/analytics-server';
import { transcriptionProvider } from '@/lib/audio/transcription';
import { wavSeconds } from '@/lib/audio/wav';
import { underLimit } from '@/lib/ratelimit';
import { getEntitlements } from '@/lib/entitlements';
import { GURU_NAME, GURU_MODEL, speak, plainForSpeech } from '@/lib/guru';
import { expressionFor } from '@/lib/guru-expression';
import { DEFAULT_STYLE } from '@/lib/styles';
import { classifyIntent, CAPTURE_INTENTS, ARCHIVE_INTENTS, NEW_DREAM } from '@/lib/orin/intent';
import { PERSONA, turnInstructions, RESPONSE_FORMAT, lensFor } from '@/lib/orin/persona';
import { buildGuruContext, renderContext } from '@/lib/orin/context';
import { checkReply, questionsLeft, mayOfferVisualize } from '@/lib/orin/guards';
import { allowance, recordUsage, usageRow } from '@/lib/orin/usage';
import { parseQuery, relevantMemories, searchArchive } from '@/lib/memory/search';
import { findMentions } from '@/lib/memory/entities';
import { loadIndex, loadEntityStats, loadOccurrences, loadPatterns, activity, markStale } from '@/lib/memory/store';
import { processMemory, syncMemories } from '@/lib/memory/process';
import { cinematicReady } from '@/lib/cinema/start';

export const maxDuration = 60;
export const runtime = 'nodejs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const HISTORY = 14;

/**
 * One turn with Orin — the Guru-first conversation (home screen, voice or text).
 * Multipart form: text | audio, conversationId?, dreamId? (talk about a saved dream), speak=1?
 *
 *   1. allowance + abuse limits      4. retrieve only relevant memory     7. save Orin's reply
 *   2. what they said (transcribe)   5. Orin answers (intent-specific)    8. memory builds after
 *   3. SAVE the dream first          6. guards: no invented past          9. voice (optional)
 */
export async function POST(req) {
  const auth = await requireUser(req);
  if (!auth) return json({ error: 'Not signed in.' }, 401);
  const { user, supabase: db } = auth;
  if (!process.env.OPENAI_API_KEY) return json({ error: 'The app is missing its OPENAI_API_KEY.' }, 500);

  // 1. Access — decided here from trusted data (plan from the Stripe webhook), never the request.
  const ent = await getEntitlements(db, user.id);
  if (!ent.canUseGuru) return json({ error: `${GURU_NAME} isn't available on this account.` }, 402);

  const form = await req.formData().catch(() => null);
  if (!form) return json({ error: 'Nothing was sent.' }, 400);
  const audio = form.get('audio');
  const viaVoice = Boolean(audio && typeof audio === 'object' && audio.size > 0);
  if (viaVoice && audio.size > MAX_AUDIO_BYTES) return json({ error: 'That recording is too long. Try a shorter one.' }, 413);
  const wantsAudio = viaVoice || form.get('speak') === '1';
  const askedConversation = String(form.get('conversationId') || '');
  const askedDream = String(form.get('dreamId') || '');
  if ((askedConversation && !UUID.test(askedConversation)) || (askedDream && !UUID.test(askedDream))) return json({ error: 'Not found.' }, 404);

  if (!(await underLimit(user.id, 'guruChat'))) return json({ error: 'Let’s pause for a little while — you can talk again soon.' }, 429);
  if (viaVoice && !(await underLimit(user.id, 'guruVoice'))) return json({ error: 'Let’s pause the voice for a little while — you can still type.', canType: true }, 429);
  let admin = null;
  try { admin = getServiceSupabase(); } catch {}
  const left = await allowance(db, admin, user.id, ent);
  if (viaVoice ? left.voiceLeft <= 0 : left.textLeft <= 0) {
    await logEvent(db, user.id, 'guru_limit_reached', { voice: viaVoice, plan: ent.plan });
    return json({
      error: viaVoice
        ? (left.textLeft > 0 ? `That’s all the voice for today. You can still type to ${GURU_NAME}.` : `You’ve talked a lot with ${GURU_NAME} today. Come back tomorrow.`)
        : `You’ve talked a lot with ${GURU_NAME} today. Come back tomorrow.`,
      limit: true, canType: viaVoice && left.textLeft > 0, upgrade: ent.plan !== 'premium' && ent.upgradeAvailable,
    }, 402);
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const usage = [];

  // 2. What did they say?
  let text = String(form.get('text') || '').trim().slice(0, 4000);
  if (viaVoice) {
    try {
      const t = await transcriptionProvider(openai).transcribe(audio, { prompt: 'Someone who just woke up, telling a dream companion what they remember of a dream, or asking about their dreams.' });
      text = t.text.slice(0, 4000);
      usage.push(usageRow({ kind: 'transcription', model: t.model, words: text.split(/\s+/).length }));
      await logEvent(db, user.id, 'guru_voice_started', {});
    } catch (e) {
      console.error('guru transcription failed', e?.message || e);
      return json({ error: "I couldn't hear that clearly. Try again, a little closer to the phone — or type it.", canType: true }, 400);
    }
  }
  if (!text) return json({ error: viaVoice ? "I didn't catch any words. Try again?" : 'Say something first.' }, 400);

  // The conversation (owned by this person, or a new one).
  let convo = null;
  if (askedConversation) {
    ({ data: convo } = await db.from('guru_conversations').select('*').eq('id', askedConversation).eq('user_id', user.id).maybeSingle());
  }
  if (askedDream) {
    const { data: own } = await db.from('dreams').select('id').eq('id', askedDream).eq('user_id', user.id).maybeSingle();
    if (!own) return json({ error: 'Dream not found.' }, 404);
    if (convo && convo.dream_id !== askedDream) convo = null; // a new conversation about that dream
  }
  if (!convo) {
    const { data: created, error } = await db.from('guru_conversations')
      .insert({ user_id: user.id, dream_id: askedDream || null }).select('*').single();
    if (error) { console.error('conversation', error.message); return json({ error: 'Could not start the conversation. Please try again.', text }, 500); }
    convo = created;
  }

  const DREAM_FIELDS = 'id, user_id, created_at, title, transcript, status, source, scenes';
  let dream = null;
  if (convo.dream_id) {
    ({ data: dream } = await db.from('dreams').select(DREAM_FIELDS).eq('id', convo.dream_id).eq('user_id', user.id).maybeSingle());
  }

  const [{ data: recent }, entityStats, index, occurrences, act, profile] = await Promise.all([
    db.from('guru_messages').select('role, content, intent, memory_refs, created_at').eq('conversation_id', convo.id).eq('user_id', user.id)
      .order('created_at', { ascending: false }).limit(HISTORY),
    loadEntityStats(db, user.id),
    loadIndex(db, user.id, ent.recallDepth),
    loadOccurrences(db, user.id),
    activity(db, user.id),
    getProfile(db, user.id),
  ]);
  const history = (recent || []).reverse();
  const lastOrin = [...history].reverse().find((m) => m.role === 'assistant');

  let intent = classifyIntent(text, {
    capturing: Boolean(convo.capture_open && dream),
    orinAsked: /\?\s*$/.test(lastOrin?.content || ''),
    hasDream: Boolean(dream),
    mentionsEntity: findMentions(text, entityStats).length > 0,
  });

  // 3. CAPTURE — the dream is saved BEFORE Orin answers. Nothing after this can lose it.
  let saved = false, newDream = false;
  if (CAPTURE_INTENTS.has(intent)) {
    const continuing = convo.capture_open && dream && !NEW_DREAM.test(text);
    if (continuing) {
      const { error } = await db.from('dreams').update({ transcript: `${dream.transcript || ''}\n\n${text}`.trim(), updated_at: new Date().toISOString() })
        .eq('id', dream.id).eq('user_id', user.id);
      if (error) { console.error('append dream', error.message); return json({ error: 'Could not save that. Please try again.', text }, 500); }
      dream.transcript = `${dream.transcript || ''}\n\n${text}`.trim();
      await markStale(db, user.id, dream.id);
      saved = true;
    } else if (intent === 'dream_capture' && (!dream || NEW_DREAM.test(text))) {
      const { data: created, error } = await db.from('dreams').insert({
        user_id: user.id, transcript: text, status: 'saved', source: 'guru', style: DEFAULT_STYLE, is_public: false,
      }).select(DREAM_FIELDS).single();
      if (error) { console.error('save dream', error.message); return json({ error: 'Could not save your dream. Please try again — your words are below.', text }, 500); }
      dream = created;
      const { data: moved } = await db.from('guru_conversations')
        .update({ dream_id: dream.id, capture_open: true, clarifications: 0, visualize_offered: false, updated_at: new Date().toISOString() })
        .eq('id', convo.id).eq('user_id', user.id).select('*').single();
      convo = moved || { ...convo, dream_id: dream.id, capture_open: true, clarifications: 0, visualize_offered: false };
      saved = newDream = true;
      await logEvent(db, user.id, 'dream_capture_started', { voice: viaVoice, first: act.total === 0 });
      await logEvent(db, user.id, 'dream_saved', { source: 'guru', first: act.total === 0 });
    } else {
      // Talking about a dream already saved (or an answer with nothing being captured): discussion.
      intent = dream ? 'reflection' : 'general_dream_discussion';
    }
  }
  const capture = CAPTURE_INTENTS.has(intent);
  if (newDream) act.total += 1;

  // The person's words are kept before the AI call, so a failed reply never loses them.
  const { error: qErr } = await db.from('guru_messages').insert({
    conversation_id: convo.id, dream_id: dream?.id || null, user_id: user.id, role: 'user', content: text, via_voice: viaVoice, intent,
  });
  if (qErr) console.error('saving guru message failed', qErr.message);

  // 4. Retrieve ONLY what's relevant — scoped to this person on every query.
  const about = capture && dream ? dream.transcript : `${text} ${dream?.transcript || ''}`;
  const query = parseQuery(about, entityStats);
  const relevant = relevantMemories(index, query, { occurrences, exclude: dream?.id, limit: 4 });
  let archive = null;
  if (ARCHIVE_INTENTS.has(intent)) {
    const ask = parseQuery(text, entityStats);
    archive = searchArchive(index, ask, { occurrences, exclude: intent === 'search' ? null : dream?.id });
    await logEvent(db, user.id, intent === 'search' ? 'dream_search_used' : 'dream_recalled', { intent, results: archive.count });
  }
  const mentioned = new Set([...query.entities, ...findMentions(text, entityStats)].map((e) => e.id));
  const entities = entityStats.filter((e) => mentioned.has(e.id));
  const liveIds = new Set(index.map((m) => m.dream_id));
  const allPatterns = (await loadPatterns(db, user.id, liveIds))
    .filter((p) => ent.canViewAdvancedPatterns || p.pattern_type === 'recurring_entity' || p.pattern_type === 'recurring_theme');
  const keys = new Set([...entities.map((e) => `${e.entity_type}:${e.norm_key}`), ...query.motifs.map((m) => `theme:${m}`)]);
  let patterns = allPatterns.filter((p) => [...keys].some((k) => p.pattern_key.includes(k)));
  if (intent === 'pattern_question' && !patterns.length && !query.motifs.length && !entities.length) patterns = allPatterns.slice(0, 4);

  let memoryRow = null;
  if (dream) ({ data: memoryRow } = await db.from('dream_memories').select('title, summary, emotions, places, objects, people, creatures, dream_type, status').eq('dream_id', dream.id).eq('user_id', user.id).maybeSingle());
  const ctx = buildGuruContext({
    currentDream: dream ? { ...dream, memory: memoryRow?.status === 'ready' ? memoryRow : null } : null,
    relevant, archive, entities, patterns, activity: act,
  });

  // Visualizing: offered rarely, and only for a dream that can actually become a reel.
  const reelsOn = Boolean(process.env.FAL_KEY); // no video/picture provider on this deployment = nothing to offer
  const reelState = dream ? await reelStateFor(db, admin, user.id, dream) : 'none';
  const userTurns = history.filter((m) => m.role === 'user').length + 1;
  const canOffer = mayOfferVisualize({
    dream, memory: memoryRow?.status === 'ready' ? memoryRow : null, hasProduction: reelState !== 'none',
    canGenerateReel: reelsOn && ent.canGenerateReel, offeredAlready: convo.visualize_offered, userTurns,
  });
  let visualize = null;
  if (intent === 'visualization_request') {
    if (!dream) visualize = 'no_dream';
    else if (reelState !== 'none' || (dream.scenes || []).length) visualize = 'exists';
    else if (!reelsOn) visualize = 'unavailable';
    else if (!ent.canGenerateReel) visualize = (await cinematicReady()) ? 'no_credits' : 'unavailable';
    else visualize = 'ready';
  }

  // 5. Orin answers. Old replies that cited a since-deleted dream are left out of his view.
  const cited = new Set(history.flatMap((m) => m.memory_refs || []));
  const existing = cited.size ? new Set(((await db.from('dreams').select('id').eq('user_id', user.id).in('id', [...cited])).data || []).map((d) => d.id)) : new Set();
  const past = history.filter((m) => !(m.memory_refs || []).some((id) => !existing.has(id)));
  const system = [
    PERSONA(GURU_NAME),
    turnInstructions(intent, {
      voice: wantsAudio, questionsLeft: capture ? questionsLeft(convo) : 1, firstDream: ctx.firstDream,
      mayOfferVisualize: canOffer, archive, lens: lensFor(profile.guru_tradition), visualize,
    }),
    renderContext(ctx),
    RESPONSE_FORMAT,
  ].join('\n\n');
  const messages = [
    { role: 'system', content: system },
    ...past.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: text },
  ];
  const userSaidAgain = /\b(again|before|recurring|keep (having|dreaming)|same dream)\b/i.test(text);
  let reply = null;
  try {
    for (let attempt = 0; attempt < 2 && !reply?.ok; attempt++) {
      const completion = await openai.chat.completions.create({
        model: GURU_MODEL, temperature: 0.7, max_tokens: wantsAudio ? 320 : 520, response_format: { type: 'json_object' },
        messages: attempt === 0 ? messages : [...messages, { role: 'system', content: 'Your last draft referred to earlier dreams, but this person has NO earlier dreams saved. Rewrite without any reference to the past.' }],
      });
      usage.push(usageRow({ kind: 'llm', model: GURU_MODEL, usage: completion.usage }));
      reply = checkReply(completion.choices[0].message.content, { refs: ctx.refs, firstDream: ctx.firstDream, userSaidAgain });
      if (reply.fabricatedPast) console.warn('guru: reply referred to a past that does not exist; retrying');
    }
  } catch (e) {
    console.error('guru talk failed', e?.message || e);
  }
  if (!reply?.ok) {
    // Never show an invented memory. A plain, honest fallback instead.
    reply = {
      text: saved ? `I’ve kept this dream for you. Tell me anything else that comes back to you.` : `I’m quiet for a moment. Could you say that again?`,
      expression: 'warm', askedQuestion: false, dreamComplete: false, offerVisualize: false, cited: [], ok: true, fallback: true,
    };
  }
  const offer = canOffer && reply.offerVisualize;

  // 7. Save Orin's reply and the conversation state.
  const { data: savedReply } = await db.from('guru_messages').insert({
    conversation_id: convo.id, dream_id: dream?.id || null, user_id: user.id, role: 'assistant', content: reply.text,
    via_voice: wantsAudio, intent, memory_refs: reply.cited,
  }).select('id').single();
  const asked = capture && reply.askedQuestion;
  const stillTelling = capture && !reply.dreamComplete && asked; // waiting for their answer
  await db.from('guru_conversations').update({
    clarifications: (convo.clarifications || 0) + (asked ? 1 : 0),
    capture_open: capture ? !reply.dreamComplete : convo.capture_open,
    visualize_offered: convo.visualize_offered || offer,
    updated_at: new Date().toISOString(),
  }).eq('id', convo.id).eq('user_id', user.id);
  if (asked) await logEvent(db, user.id, 'clarification_asked', { n: (convo.clarifications || 0) + 1 });
  if (offer) await logEvent(db, user.id, 'visualize_offered', {});

  // 8. Memory: built in the background once the dream has been told; otherwise retry anything pending.
  if (dream && capture && !stillTelling) after(() => processMemory(db, user.id, dream.id));
  else after(() => syncMemories(db, user.id, 1));

  // 9. Voice
  let audioB64 = null;
  let tts = null;
  if (wantsAudio) {
    try {
      tts = await speak(openai, plainForSpeech(reply.text));
      audioB64 = tts.wav.toString('base64');
      usage.push(usageRow({ kind: 'tts', model: tts.model, seconds: wavSeconds(tts.wav) }));
    } catch (e) {
      console.error('guru speech failed', e?.message || e);
    }
  }
  after(() => recordUsage(db, user.id, usage));
  // Behaviour only — never what was said.
  await logEvent(db, user.id, 'guru_response_completed', {
    voice: viaVoice, spoken: Boolean(audioB64), intent, saved, fallback: Boolean(reply.fallback),
    ...(tts ? { tts_model: tts.model, tts_fallback_used: Boolean(tts.fallbackUsed) } : {}),
  });
  if (viaVoice) await logEvent(db, user.id, 'guru_voice_completed', { spoken: Boolean(audioB64) });

  const titles = new Map(index.map((m) => [m.dream_id, m]));
  return json({
    conversationId: convo.id,
    dreamId: dream?.id || null,
    saved, newDream,
    question: text,
    answer: reply.text,
    messageId: savedReply?.id || null,
    expression: reply.expression || expressionFor(reply.text),
    audio: audioB64, audioType: 'audio/wav',
    intent,
    offerVisualize: offer,
    action: visualize === 'ready' ? { type: 'confirm_visualize', dreamId: dream.id } : null,
    results: archive ? archive.matches.slice(0, 12).map((r) => ({ id: r.memory.dream_id, title: r.memory.title || 'Untitled dream', date: r.memory.dream_at })) : null,
    cited: reply.cited.map((id) => ({ id, title: titles.get(id)?.title || 'An earlier dream', date: titles.get(id)?.dream_at || null })),
    left: { text: left.textLeft - (viaVoice ? 0 : 1), voice: left.voiceLeft - (viaVoice ? 1 : 0) },
  });
}

/** 'none' | 'making' | 'done' — whether this dream already has (or is getting) a reel. */
async function reelStateFor(db, admin, userId, dream) {
  if ((dream.scenes || []).length) return 'done';
  const { data: reel } = await db.from('dream_reels').select('status').eq('dream_id', dream.id).eq('user_id', userId).maybeSingle();
  if (reel) return reel.status === 'completed' ? 'done' : 'making';
  if (admin) {
    const { data: prod } = await admin.from('dream_productions').select('status').eq('dream_id', dream.id).eq('user_id', userId).maybeSingle();
    if (prod && prod.status !== 'failed') return prod.status === 'completed' ? 'done' : 'making';
  }
  return 'none';
}
