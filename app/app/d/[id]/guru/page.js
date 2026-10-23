import GuruScreen from '@/components/GuruScreen';
import { GURU_NAME } from '@/lib/guru-public';

export const metadata = {
  title: `${GURU_NAME} · Dream Guru`,
  robots: { index: false, follow: false },
};

export default async function GuruPage({ params }) {
  const { id } = await params;
  return <GuruScreen dreamId={id} />;
}
