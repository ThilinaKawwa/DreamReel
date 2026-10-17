import { json, requireUser } from '@/lib/server';
import { signScenes } from '@/lib/cinema/scene-links';

export const runtime = 'nodejs';

/** Short-lived links to this dream's private pictures. Owner only. */
export async function GET(req, { params }) {
  const auth = await requireUser(req);
  if (!auth) return json({ error: 'Not signed in.' }, 401);
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: 'Not found.' }, 404);
  // Ownership comes from the database row, matched to the signed-in user — never from the request.
  const { data: dream } = await auth.supabase.from('dreams').select('id, user_id, scenes').eq('id', id).eq('user_id', auth.user.id).maybeSingle();
  if (!dream) return json({ error: 'Not found.' }, 404);
  return json({ scenes: await signScenes(dream) });
}
