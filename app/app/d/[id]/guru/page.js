import { redirect } from 'next/navigation';

// Talking about one dream now happens on the home screen with Orin (same conversation engine).
export default async function GuruPage({ params }) {
  const { id } = await params;
  redirect(/^[0-9a-f-]{36}$/i.test(id) ? `/?dream=${id}` : '/');
}
