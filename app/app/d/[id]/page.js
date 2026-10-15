import { getPublicSupabase } from '@/lib/supabase';
import DreamView from '@/components/DreamView';
import { BRAND } from '@/lib/brand';

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
  if (!error) return data?.[0] || null;
  // Before the reels migration has been run, fall back to the old read (minus the transcript).
  const { data: row } = await supabase.from('dreams').select('id, title, scenes, style, created_at, status, is_public').eq('id', id).maybeSingle();
  return row?.is_public ? row : null;
}

export default async function DreamPage({ params }) {
  const { id } = await params;
  const dream = await loadSharedDream(id);
  return <DreamView dream={dream} id={id} />;
}
