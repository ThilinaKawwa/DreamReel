import { after } from 'next/server';
import { json, requireUser } from '@/lib/server';
import { syncMemories } from '@/lib/memory/process';

export const maxDuration = 60;
export const runtime = 'nodejs';

/**
 * Called quietly when the app opens: builds memories that are missing, out of date or failed
 * (including dreams recorded before Dream Guru V2), a couple at a time, after responding.
 */
export async function POST(req) {
  const auth = await requireUser(req);
  if (!auth) return json({ error: 'Not signed in.' }, 401);
  after(() => syncMemories(auth.supabase, auth.user.id, 2));
  return json({ ok: true }, 202);
}
