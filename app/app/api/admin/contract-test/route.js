import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import OpenAI, { toFile } from 'openai';
import { fal } from '@fal-ai/client';
import { json, requireUser } from '@/lib/server';
import { isAdmin } from '@/lib/admin';
import { models } from '@/lib/models';
import { wavSeconds } from '@/lib/audio/wav';
import { realtimeSpeak, verbatimScore, isModelUnsupported } from '@/lib/audio/speech';
import { VIDEO_ADAPTERS, o1Input, o1InputCount } from '@/lib/providers';
import { run } from '@/lib/reel/render';
import { checkClip } from '@/lib/cinema/quality';

// The smallest paid checks that prove each provider contract, BEFORE generating full reels.
// Admin-only (ADMIN_USER_IDS); everyone else gets a 404. Never touches user data.
export const maxDuration = 300;
export const runtime = 'nodejs';

const SENTENCE = 'I remember standing beside the ocean, and then the water started rising into the sky.';
const O1 = 'kling-o1-ref';

const errInfo = (e) => ({ status: e?.status ?? null, message: String(e?.message || e).slice(0, 300) });

async function openaiChecks() {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const m = models();
  const out = { speech: { model: m.tts, endpoint: '/v1/audio/speech', voice: 'marin' }, transcription: { model: m.transcription } };
  let wav = null;
  // 1. Speech through the standard endpoint (the simple path we want to use).
  try {
    const res = await openai.audio.speech.create({ model: m.tts, voice: 'marin', input: SENTENCE, response_format: 'wav' });
    wav = Buffer.from(await res.arrayBuffer());
    out.speech.http_success = true;
    out.speech.bytes = wav.length;
    out.speech.seconds = wavSeconds(wav);
    out.speech.valid_wav = Boolean(out.speech.seconds && out.speech.seconds > 0.5);
  } catch (e) {
    out.speech.http_success = false;
    out.speech.error = errInfo(e);
    out.speech.model_rejected_by_endpoint = isModelUnsupported(e);
    // Only then try the Realtime adapter, to know whether it is needed.
    try {
      const rt = await realtimeSpeak({ apiKey: process.env.OPENAI_API_KEY, model: m.tts, voice: 'marin', style: 'plain, natural', text: SENTENCE });
      wav = rt.wav;
      out.realtime_adapter = { ok: true, seconds: wavSeconds(rt.wav), verbatim: verbatimScore(SENTENCE, rt.transcript) };
    } catch (e2) {
      out.realtime_adapter = { ok: false, error: errInfo(e2) };
    }
  }
  // 2. Transcription of that audio: proves gpt-transcribe AND checks the speech said the sentence.
  if (wav) {
    try {
      const t = await openai.audio.transcriptions.create({ model: m.transcription, file: await toFile(wav, 'contract.wav', { type: 'audio/wav' }) });
      out.transcription.http_success = true;
      out.transcription.text = t.text;
      out.transcription.faithfulness = Math.round(verbatimScore(SENTENCE, t.text) * 100) / 100;
    } catch (e) {
      out.transcription.http_success = false;
      out.transcription.error = errInfo(e);
    }
  } else {
    out.transcription.skipped = 'no audio to transcribe';
  }
  out.estimated_cost_usd = 0.01;
  return out;
}

async function falSubmit() {
  fal.config({ credentials: process.env.FAL_KEY });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'o1-'));
  try {
    // Start frame + one character element (front + one genuinely different extra reference).
    const pub = (f) => path.join(process.cwd(), 'public', f);
    const flipped = path.join(dir, 'ref.jpg');
    await run(['-hide_banner', '-loglevel', 'error', '-y', '-i', pub('orin.jpg'), '-vf', 'hflip,crop=iw*0.8:ih*0.8:iw*0.1:ih*0.05', flipped], dir, 30_000);
    const up = async (file, name) => fal.storage.upload(new File([await readFile(file)], name, { type: 'image/jpeg' }));
    const [start, frontal, extra] = await Promise.all([up(pub('orin.jpg'), 'start.jpg'), up(pub('orin-avatar-256.jpg'), 'front.jpg'), up(flipped, 'ref.jpg')]);
    const input = o1Input({
      startImageUrl: start,
      prompt: 'The robed old man slowly raises his eyes and smiles gently; his cloak moves slightly in a breeze. Static camera.',
      duration: 5,
      elements: [{ label: 'the old robed man with a white beard', frontal, references: [extra] }],
    });
    const { request_id } = await fal.queue.submit(VIDEO_ADAPTERS[O1].model, { input });
    return { request_accepted: true, request_id, model: VIDEO_ADAPTERS[O1].model, payload: { ...input, input_count: o1InputCount(input) }, estimated_cost_usd: 0.56 };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function falStatus(requestId) {
  fal.config({ credentials: process.env.FAL_KEY });
  const model = VIDEO_ADAPTERS[O1].model;
  const st = await fal.queue.status(model, { requestId });
  if (st.status !== 'COMPLETED') return { job_completed: false, queue_status: st.status };
  const r = await fal.queue.result(model, { requestId });
  const url = r?.data?.video?.url || null;
  const out = { job_completed: true, output_url_returned: Boolean(url), output_url: url };
  if (url) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'o1v-'));
    try {
      const res = await fetch(url);
      const file = path.join(dir, 'clip.mp4');
      await writeFile(file, Buffer.from(await res.arrayBuffer()));
      const q = await checkClip(file);
      Object.assign(out, { video_decodes: q.ok || q.reason !== 'clip does not decode', quality: q });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  return out;
}

export async function POST(req) {
  const auth = await requireUser(req);
  if (!auth || !isAdmin(auth.user.id)) return json({ error: 'Not found.' }, 404);
  const { check, confirm, requestId } = await req.json().catch(() => ({}));
  try {
    if (check === 'openai') {
      if (confirm !== true) return json({ error: 'confirm required (spends ~$0.01)' }, 400);
      if (!process.env.OPENAI_API_KEY) return json({ error: 'OPENAI_API_KEY is not set on this deployment' }, 400);
      return json(await openaiChecks());
    }
    if (check === 'fal') {
      if (confirm !== true) return json({ error: 'confirm required (spends ~$0.56)' }, 400);
      if (!process.env.FAL_KEY) return json({ error: 'FAL_KEY is not set on this deployment' }, 400);
      return json(await falSubmit());
    }
    if (check === 'fal-status' && /^[\w-]{8,80}$/.test(requestId || '')) return json(await falStatus(requestId));
    return json({ error: 'unknown check' }, 400);
  } catch (e) {
    return json({ ok: false, error: errInfo(e) }, 200);
  }
}
