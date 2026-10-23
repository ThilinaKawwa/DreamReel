import { json, requireUser } from '@/lib/server';
import { signScenes } from '@/lib/cinema/scene-links';

export const runtime = 'nodejs';

/** Cover pictures for the signed-in person's own dreams (gallery). */
export async function POST(req) {
  const auth = await requireUser(req);
  if (!auth) return json({ error: 'Not signed in.' }, 401);
  const { ids } = await req.json().catch(() => ({}));
  const list = (Array.isArray(ids) ? ids : []).filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 60);
  if (!list.length) return json({ covers: {} });
  const { data } = await auth.supabase.from('dreams').select('id, user_id, scenes').in('id', list).eq('user_id', auth.user.id);
  const covers = {};
  for (const d of data || []) {
    if (!d.scenes?.[0]?.image_path) continue;
    const [first] = await signScenes({ ...d, scenes: d.scenes.slice(0, 1) });
    if (first?.image_url) covers[d.id] = first.image_url;
  }
  return json({ covers });
}
