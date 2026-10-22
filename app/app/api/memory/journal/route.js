import { json, requireUser } from '@/lib/server';
import { logEvent } from '@/lib/analytics-server';
import { signScenes } from '@/lib/cinema/scene-links';
import { loadIndex, loadEntityStats, loadOccurrences } from '@/lib/memory/store';
import { parseQuery, searchArchive } from '@/lib/memory/search';

export const runtime = 'nodejs';

/**
 * My Dreams: the person's private dream archive, newest first. ?q= searches it (the same
 * search Orin uses, so results are real stored dreams only). ?visual=1 = only dreams with pictures.
 */
export async function GET(req) {
  const auth = await requireUser(req);
  if (!auth) return json({ error: 'Not signed in.' }, 401);
  const { supabase: db, user } = auth;
  const url = new URL(req.url);
  const q = (url.searchParams.get('q') || '').trim().slice(0, 200);
  const visual = url.searchParams.get('visual') === '1';

  const [{ data: dreams }, { data: mems }, { data: convos }, { data: reels }] = await Promise.all([
    db.from('dreams').select('id, user_id, created_at, title, status, source, scenes, transcript').eq('user_id', user.id)
      .in('status', ['ready', 'saved', 'pending']).order('created_at', { ascending: false }).limit(200),
    db.from('dream_memories').select('dream_id, title, summary, emotions, status').eq('user_id', user.id).limit(1000),
    db.from('guru_conversations').select('dream_id').eq('user_id', user.id).not('dream_id', 'is', null).limit(1000),
    db.from('dream_reels').select('dream_id, status').eq('user_id', user.id).limit(1000),
  ]);
  let list = (dreams || []).filter((d) => !visual || (d.scenes || []).length);
  if (q) {
    const [index, stats, occurrences] = await Promise.all([loadIndex(db, user.id, 1000), loadEntityStats(db, user.id), loadOccurrences(db, user.id)]);
    const found = searchArchive(index, parseQuery(q, stats), { occurrences });
    const hit = new Set(found.matches.map((r) => r.memory.dream_id));
    list = list.filter((d) => hit.has(d.id));
    await logEvent(db, user.id, 'dream_search_used', { from: 'journal', results: list.length });
  }
  const mem = new Map((mems || []).filter((m) => m.status === 'ready').map((m) => [m.dream_id, m]));
  const talked = new Set((convos || []).map((c) => c.dream_id));
  const filmed = new Map((reels || []).map((r) => [r.dream_id, r.status]));

  const items = await Promise.all(list.slice(0, 120).map(async (d, i) => {
    const m = mem.get(d.id);
    let cover = null;
    if ((d.scenes || []).length) {
      const first = d.scenes[0];
      if (first?.image_path) {
        // Private pictures get short-lived links — for the first screenful only.
        if (i < 40) cover = (await signScenes({ ...d, scenes: [first] }).catch(() => []))[0]?.image_url || null;
      } else cover = first?.image_url || null;
    }
    return {
      id: d.id,
      date: d.created_at,
      title: d.title || m?.title || 'A remembered dream',
      summary: m?.summary || oneLine(d.transcript),
      mood: m?.emotions?.[0] || null,
      cover,
      talked: talked.has(d.id) || d.source === 'guru',
      visual: (d.scenes || []).length > 0 || filmed.has(d.id),
      filmReady: filmed.get(d.id) === 'completed',
      making: d.status === 'pending',
    };
  }));
  return json({ items, total: list.length });
}

function oneLine(t) {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  return s.length > 110 ? `${s.slice(0, 108)}…` : s;
}
