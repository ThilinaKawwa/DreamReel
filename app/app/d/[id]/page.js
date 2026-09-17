import { getPublicSupabase } from '@/lib/supabase';
import DreamView from '@/components/DreamView';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }) {
  const { id } = await params;
  const dream = await loadDream(id);
  const title = dream?.title ? `${dream.title} · Dream Reel` : 'Dream Reel';
  const image = dream?.scenes?.[0]?.image_url;
  return {
    title,
    description: dream?.scenes?.[0]?.caption || 'A dream, painted.',
    openGraph: { title, images: image ? [image] : [] },
    twitter: { card: 'summary_large_image', title, images: image ? [image] : [] },
  };
}

async function loadDream(id) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const supabase = getPublicSupabase();
  const { data } = await supabase.from('dreams').select('*').eq('id', id).maybeSingle();
  return data;
}

export default async function DreamPage({ params }) {
  const { id } = await params;
  const dream = await loadDream(id);
  return <DreamView dream={dream} id={id} />;
}
