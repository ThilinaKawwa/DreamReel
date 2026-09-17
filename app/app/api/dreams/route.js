import OpenAI from 'openai';
import { fal } from '@fal-ai/client';
import { getUserSupabase } from '@/lib/supabase';
import { STYLES, DEFAULT_STYLE } from '@/lib/styles';

// Let this function run for up to 60 seconds (painting 5 pictures takes ~15–30s).
export const maxDuration = 60;
export const runtime = 'nodejs';

const SCENE_COUNT = 5;

function json(body, status = 200) {
  return Response.json(body, { status });
}

export async function POST(req) {
  // 1. Who is asking? (the browser sends the login token)
  const auth = req.headers.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'Not signed in.' }, 401);

  const supabase = getUserSupabase(token);
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) return json({ error: 'Not signed in.' }, 401);
  const user = userData.user;

  if (!process.env.OPENAI_API_KEY || !process.env.FAL_KEY) {
    return json({ error: 'The app is missing its OPENAI_API_KEY or FAL_KEY. Add them in Vercel → Settings → Environment Variables.' }, 500);
  }

  // 2. Daily limit so one person can't run up the bill
  const limit = Number(process.env.DAILY_LIMIT || 3);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from('dreams')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .gte('created_at', since);
  if ((count || 0) >= limit) {
    return json({ error: `You've made ${limit} dreams today. Come back tomorrow morning.` }, 429);
  }

  // 3. Read what was sent: either an audio file or typed text
  const form = await req.formData();
  const audio = form.get('audio');
  const typed = (form.get('text') || '').toString().trim();
  const styleKey = STYLES[form.get('style')] ? form.get('style') : DEFAULT_STYLE;

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // 4. Turn the voice note into text
  let transcript = typed;
  if (!transcript && audio && typeof audio === 'object' && audio.size > 0) {
    try {
      const result = await openai.audio.transcriptions.create({
        file: audio,
        model: 'gpt-4o-mini-transcribe',
        prompt: 'A person describing a dream they had last night.',
      });
      transcript = (result.text || '').trim();
    } catch (e) {
      console.error('transcription failed', e);
      return json({ error: "Couldn't hear that clearly. Try again, or type your dream instead." }, 400);
    }
  }
  if (!transcript || transcript.length < 8) {
    return json({ error: "That was a bit short — tell me a little more about the dream." }, 400);
  }

  // 5. Save a "pending" dream so it shows up in the library straight away
  const { data: dream, error: insErr } = await supabase
    .from('dreams')
    .insert({ user_id: user.id, transcript, style: styleKey, status: 'pending' })
    .select()
    .single();
  if (insErr) {
    console.error(insErr);
    return json({ error: 'Could not save the dream. Please try again.' }, 500);
  }

  try {
    // 6. Ask the AI to split the dream into scenes
    const scenes = await writeScenes(openai, transcript);

    // 7. Paint one picture per scene (all at the same time) and store them
    fal.config({ credentials: process.env.FAL_KEY });
    const suffix = STYLES[styleKey].suffix;
    const painted = await Promise.all(
      scenes.scenes.map(async (scene, i) => {
        const url = await paintScene(`${scene.image_prompt}, ${suffix}`);
        const stored = await storeImage(supabase, user.id, dream.id, i, url);
        return { caption: scene.caption, image_prompt: scene.image_prompt, image_url: stored };
      })
    );

    const { error: updErr } = await supabase
      .from('dreams')
      .update({ title: scenes.title, scenes: painted, status: 'ready' })
      .eq('id', dream.id);
    if (updErr) throw updErr;

    return json({ id: dream.id });
  } catch (e) {
    console.error('dream failed', e);
    await supabase.from('dreams').update({ status: 'failed', error: String(e?.message || e) }).eq('id', dream.id);
    return json({ error: 'Something went wrong while painting. Your credit was not wasted — try once more.' }, 500);
  }
}

async function writeScenes(openai, transcript) {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.8,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You turn a person's spoken description of a dream into a short visual story of exactly ${SCENE_COUNT} scenes.
Return JSON: {"title": string, "scenes": [{"caption": string, "image_prompt": string}]}.
- title: 2–5 words, poetic, no full stop.
- caption: one short sentence (max 12 words) in first person, present tense, as if narrating the dream. Keep the dreamer's own details and mood.
- image_prompt: a vivid visual description for an image generator (max 40 words). Describe the setting, subject, light and colour. No people's real names. No text in the image. Do not mention the word "dream".
- The last scene should feel like waking or an ending.
- Keep it gentle and safe for all ages, even if the dream was scary: show mood, not gore.`,
      },
      { role: 'user', content: transcript },
    ],
  });
  const parsed = JSON.parse(completion.choices[0].message.content || '{}');
  if (!Array.isArray(parsed.scenes) || parsed.scenes.length === 0) throw new Error('No scenes returned');
  parsed.scenes = parsed.scenes.slice(0, SCENE_COUNT);
  parsed.title = parsed.title || 'Last night';
  return parsed;
}

async function paintScene(prompt) {
  const result = await fal.subscribe('fal-ai/flux/schnell', {
    input: {
      prompt,
      image_size: 'portrait_16_9',
      num_images: 1,
      num_inference_steps: 4,
      enable_safety_checker: true,
    },
  });
  const url = result?.data?.images?.[0]?.url;
  if (!url) throw new Error('No image returned');
  return url;
}

/** Copies the painted image into our own storage so it never expires. */
async function storeImage(supabase, userId, dreamId, index, sourceUrl) {
  const res = await fetch(sourceUrl);
  if (!res.ok) throw new Error('Could not download image');
  const bytes = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') || 'image/jpeg';
  const ext = contentType.includes('png') ? 'png' : 'jpg';
  const path = `${userId}/${dreamId}/${index}.${ext}`;
  const { error } = await supabase.storage.from('reels').upload(path, bytes, { contentType, upsert: true });
  if (error) {
    // If storage fails, fall back to the original URL rather than losing the dream.
    console.error('storage upload failed', error);
    return sourceUrl;
  }
  const { data } = supabase.storage.from('reels').getPublicUrl(path);
  return data.publicUrl;
}
