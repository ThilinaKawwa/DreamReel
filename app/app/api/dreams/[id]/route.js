import { after } from 'next/server';
import { json, requireUser, getServiceSupabase } from '@/lib/server';
import { logEvent } from '@/lib/analytics-server';
import { getEntitlements } from '@/lib/entitlements';
import { forgetDream, markStale } from '@/lib/memory/store';
import { processMemory } from '@/lib/memory/process';
import { relationLabel } from '@/lib/memory/patterns';
import { MEDIA_BUCKET } from '@/lib/cinema/media';

export const maxDuration = 60;
export const runtime = 'nodejs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function own(req, params) {
  const auth = await requireUser(req);
  if (!auth) return { res: json({ error: 'Not signed in.' }, 401) };
  const { id } = await params;
  if (!UUID.test(id || '')) return { res: json({ error: 'Not found.' }, 404) };
  // Ownership comes from the row, matched to the signed-in user — never from the request.
  const { data: dream } = await auth.supabase.from('dreams').select('id, user_id, created_at, updated_at, title, transcript, status, source, style, scenes, is_public')
    .eq('id', id).eq('user_id', auth.user.id).maybeSingle();
  if (!dream) return { res: json({ error: 'Not found.' }, 404) };
  return { ...auth, dream };
}

/** The dream's memory page: its memory, the people/places in it, related dreams. Owner only. */
export async function GET(req, { params }) {
  const o = await own(req, params);
  if (o.res) return o.res;
  const { supabase: db, user, dream } = o;
  const [{ data: memory }, { data: occ }, { data: links }, { count: talks }, ent] = await Promise.all([
    db.from('dream_memories').select('status, title, summary, cleaned_text, dream_type, emotions, themes, people, places, objects, creatures, events, details, follow_ups, reflection, updated_at')
      .eq('dream_id', dream.id).eq('user_id', user.id).maybeSingle(),
    db.from('dream_entity_occurrences').select('entity_id, mention, confidence, dream_entities(label, entity_type, specific)')
      .eq('dream_id', dream.id).eq('user_id', user.id),
    db.from('dream_links').select('dream_a, dream_b, score, reasons').eq('user_id', user.id)
      .or(`dream_a.eq.${dream.id},dream_b.eq.${dream.id}`).order('score', { ascending: false }).limit(6),
    db.from('guru_messages').select('id', { count: 'exact', head: true }).eq('dream_id', dream.id).eq('user_id', user.id),
    getEntitlements(db, user.id),
  ]);
  const otherIds = (links || []).map((l) => (l.dream_a === dream.id ? l.dream_b : l.dream_a));
  const { data: others } = otherIds.length
    ? await db.from('dreams').select('id, title, created_at').eq('user_id', user.id).in('id', otherIds)
    : { data: [] };
  const byId = new Map((others || []).map((d) => [d.id, d]));
  const related = (links || []).map((l) => {
    const other = byId.get(l.dream_a === dream.id ? l.dream_b : l.dream_a);
    return other ? { id: other.id, title: other.title || 'Untitled dream', date: other.created_at, because: relationLabel(l), score: l.score } : null;
  }).filter(Boolean);
  // How many dreams each person/place in this one has appeared in (live counts).
  const ids = (occ || []).map((x) => x.entity_id);
  const { data: stats } = ids.length ? await db.from('dream_entity_stats').select('id, appearances').eq('user_id', user.id).in('id', ids) : { data: [] };
  const seen = new Map((stats || []).map((s) => [s.id, s.appearances]));
  const entities = (occ || []).filter((x) => x.dream_entities).map((x) => ({
    type: x.dream_entities.entity_type, label: x.dream_entities.label, specific: x.dream_entities.specific,
    dreams: seen.get(x.entity_id) || 1, sure: x.confidence >= 0.8,
  }));
  return json({
    dream: { id: dream.id, title: dream.title, created_at: dream.created_at, transcript: dream.transcript, status: dream.status, source: dream.source, hasScenes: (dream.scenes || []).length > 0, isPublic: dream.is_public },
    memory: memory?.status === 'ready' ? memory : null,
    memoryStatus: memory?.status || 'pending',
    entities, related,
    talkedWithGuru: (talks || 0) > 0,
    canVisualize: Boolean(process.env.FAL_KEY) && ent.canGenerateReel && !(dream.scenes || []).length,
  });
}

/** Edit the title or their own words. The memory is rebuilt from the new version. */
export async function PATCH(req, { params }) {
  const o = await own(req, params);
  if (o.res) return o.res;
  const { supabase: db, user, dream } = o;
  const body = await req.json().catch(() => ({}));
  const patch = {};
  if (typeof body.title === 'string') patch.title = body.title.replace(/\s+/g, ' ').trim().slice(0, 80) || null;
  if (typeof body.transcript === 'string') {
    const t = body.transcript.trim().slice(0, 8000);
    if (t.length < 3) return json({ error: 'A dream needs a few words.' }, 400);
    patch.transcript = t;
  }
  if (!Object.keys(patch).length) return json({ error: 'Nothing to change.' }, 400);
  const { error } = await db.from('dreams').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', dream.id).eq('user_id', user.id);
  if (error) return json({ error: 'Could not save the change.' }, 500);
  if (patch.transcript !== undefined) {
    await markStale(db, user.id, dream.id);
    after(() => processMemory(db, user.id, dream.id));
  }
  await logEvent(db, user.id, 'dream_edited', { words: patch.transcript !== undefined, title: patch.title !== undefined });
  return json({ ok: true });
}

/**
 * Deletes a dream and everything derived from it: its memory, entity appearances,
 * related-dream links and Guru messages go with it (database cascades); entities nothing
 * refers to any more are removed and patterns are rebuilt BEFORE this returns, so Orin can
 * never cite it again. Its credit is never given back (see reel_credits).
 */
export async function DELETE(req, { params }) {
  const o = await own(req, params);
  if (o.res) return o.res;
  const { supabase: db, user, dream } = o;
  const { error } = await db.from('dreams').delete().eq('id', dream.id).eq('user_id', user.id);
  if (error) { console.error('delete dream', error.message); return json({ error: 'Could not delete the dream.' }, 500); }
  try { await forgetDream(db, user.id); } catch (e) { console.error('forget dream', e?.message || e); }
  after(() => removeFiles(user.id, dream.id));
  await logEvent(db, user.id, 'dream_deleted', { source: dream.source || 'reel' });
  return json({ ok: true });
}

/** Best effort: its pictures and films in storage (paths rebuilt from the owner's ids). */
async function removeFiles(userId, dreamId) {
  let admin;
  try { admin = getServiceSupabase(); } catch { return; }
  for (const bucket of [MEDIA_BUCKET, 'dream-videos', 'reels']) {
    try {
      const { data } = await admin.storage.from(bucket).list(`${userId}/${dreamId}`, { limit: 200 });
      const files = (data || []).map((f) => `${userId}/${dreamId}/${f.name}`);
      if (files.length) await admin.storage.from(bucket).remove(files);
    } catch {}
  }
}
