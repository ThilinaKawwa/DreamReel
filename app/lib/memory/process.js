// Runs memory building for a person, safely. Server only. The dream is always saved before
// this runs; if anything here fails, the dream stays saved and is retried later
// (dreamsNeedingMemory), so derived data can never cost someone their dream.
import OpenAI from 'openai';
import { getServiceSupabase } from '@/lib/server';
import { logEvent } from '@/lib/analytics-server';
import { buildMemory, dreamsNeedingMemory } from '@/lib/memory/store';
import { recordUsage, usageRow } from '@/lib/orin/usage';

/** The DreamBible, if the Dream Director already made one for this dream (server-only table). */
async function bibleFor(userId, dreamId) {
  try {
    const { data } = await getServiceSupabase().from('dream_productions').select('bible')
      .eq('dream_id', dreamId).eq('user_id', userId).maybeSingle();
    return data?.bible || null;
  } catch { return null; }
}

export async function processMemory(db, userId, dreamId) {
  if (!process.env.OPENAI_API_KEY) return 'skipped';
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const rows = [];
  try {
    const result = await buildMemory(db, openai, {
      userId, dreamId, bible: await bibleFor(userId, dreamId),
      onUsage: (u) => rows.push(usageRow(u)),
    });
    if (result === 'built') await logEvent(db, userId, 'memory_built', {});
    return result;
  } catch (e) {
    console.error('memory build failed', dreamId, e?.message || e);
    await logEvent(db, userId, 'memory_failed', {});
    return 'failed';
  } finally {
    await recordUsage(db, userId, rows);
  }
}

/** Builds memories that are missing, out of date or failed (a few at a time, to bound cost). */
export async function syncMemories(db, userId, max = 1) {
  const ids = await dreamsNeedingMemory(db, userId, max).catch(() => []);
  for (const id of ids) await processMemory(db, userId, id);
  return ids.length;
}
