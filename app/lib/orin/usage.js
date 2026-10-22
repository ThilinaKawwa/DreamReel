// Guru cost control: allowance per plan, and cost metadata per call (numbers only, never text).
import { UNIT } from '../cinema/costs.js';

const num = (v, d) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

/** USD per 1M tokens (list prices are estimates; override with env). */
export function tokenPrices(model, env = process.env) {
  if (/mini/.test(model)) return { in: num(env.PRICE_MINI_IN_PER_M, 0.4), out: num(env.PRICE_MINI_OUT_PER_M, 1.6) };
  return { in: num(env.PRICE_GURU_IN_PER_M, 2), out: num(env.PRICE_GURU_OUT_PER_M, 8) };
}

/** One guru_usage row. kind: transcription | llm | tts | memory */
export function usageRow({ kind, model, usage, seconds, words }) {
  if (kind === 'llm' || kind === 'memory') {
    const p = tokenPrices(model);
    const tin = usage?.prompt_tokens || 0, tout = usage?.completion_tokens || 0;
    return { kind, model, quantity: tin + tout, unit: 'tokens', est_usd: round((tin * p.in + tout * p.out) / 1e6) };
  }
  if (kind === 'transcription') {
    const minutes = Math.max(0.05, (words || 0) / 150); // ~150 spoken words a minute (estimate)
    return { kind, model, quantity: round(minutes), unit: 'audio minute (est.)', est_usd: round(minutes * UNIT.transcribePerMinute) };
  }
  const minutes = (seconds || 0) / 60;
  return { kind, model, quantity: round(minutes), unit: 'spoken minute', est_usd: round(minutes * UNIT.ttsPerMinute) };
}

/** Records cost lines. Never throws; a missing table must not break a conversation. */
export async function recordUsage(db, userId, rows) {
  if (!rows.length) return;
  try {
    const { error } = await db.from('guru_usage').insert(rows.map((r) => ({ ...r, user_id: userId })));
    if (error && !/relation .* does not exist|schema cache/i.test(error.message)) console.error('guru usage', error.message);
  } catch {}
}

/**
 * What's left of today's allowance (rolling 24 h). Counted from the analytics log, which
 * people can add to but never edit or delete — so deleting a dream or a conversation can't
 * reset it. `admin` is the service-role client; without it, saved messages are counted.
 */
export async function allowance(db, admin, userId, ent) {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const count = (voice) => (admin
    ? admin.from('analytics_events').select('id', { count: 'exact', head: true })
      .eq('user_id', userId).eq('event', 'guru_response_completed').filter('props->>voice', 'eq', String(voice)).gte('created_at', since)
    : db.from('guru_messages').select('id', { count: 'exact', head: true })
      .eq('user_id', userId).eq('role', 'user').eq('via_voice', voice).gte('created_at', since)
  ).then(({ count: c, error }) => (error ? 0 : c || 0), () => 0);
  const [text, voice] = await Promise.all([count(false), count(true)]);
  return {
    textLeft: Math.max(0, ent.guruTextPerDay - text),
    voiceLeft: Math.max(0, ent.guruVoicePerDay - voice),
  };
}

const round = (x) => Math.round(x * 1e6) / 1e6;
