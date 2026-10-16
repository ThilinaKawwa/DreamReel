import { getPublicSupabase } from '@/lib/supabase';
import DreamView from '@/components/DreamView';
import { BRAND } from '@/lib/brand';
import { getServiceSupabase } from '@/lib/server';
import { signScenes } from '@/lib/cinema/scene-links';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }) {
  const { id } = await params;
  const dream = await loadSharedDream(id);
  const title = dream?.title ? `${dream.title} · ${BRAND.name}` : BRAND.name;
  const image = dream?.scenes?.[0]?.image_url;
  return {
    title,
    description: dream ? BRAND.promise : 'A dream, kept.',
    openGraph: { title, images: image ? [image] : [] },
    twitter: { card: 'summary_large_image', title, images: image ? [image] : [] },
    robots: { index: false, follow: false }, // dreams are personal: never in search engines
  };
}

/**
 * A dream someone chose to share, read by its id only — never the transcript.
 * Private dreams return null here; their owner loads them in the browser instead.
 */
async function loadSharedDream(id) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const supabase = getPublicSupabase();
  const { data, error } = await supabase.rpc('get_shared_dream', { p_id: id });
  if (!error) return withLinks(data?.[0] || null);
  // Before the reels migration has been run, fall back to the old read (minus the transcript).
  const { data: row } = await supabase.from('dreams').select('id, title, scenes, style, created_at, status, is_public').eq('id', id).maybeSingle();
  return row?.is_public ? row : null;
}

/**
 * Dream Director pictures are private. For a dream its owner chose to share, the server
 * signs short-lived links (re-checking is_public itself); the storage paths never leave it.
 */
async function withLinks(dream) {
  if (!dream || !dream.scenes?.some((s) => s?.image_path)) return dream;
  try {
    const { data: row } = await getServiceSupabase().from('dreams').select('id, user_id, scenes, is_public').eq('id', dream.id).maybeSingle();
    if (!row?.is_public) return null;
    return { ...dream, scenes: await signScenes(row, 24 * 3600) };
  } catch {
    return { ...dream, scenes: dream.scenes.map(({ image_path, ...s }) => s) };
  }
}

export default async function DreamPage({ params }) {
  const { id } = await params;
  const dream = await loadSharedDream(id);
  return <DreamView dream={dream} id={id} />;
}
