import { json, requireUser, getProfile } from '@/lib/server';
import { getStripe, siteUrl } from '@/lib/stripe';

export const runtime = 'nodejs';

/** Opens Stripe's page where people can change card details or cancel. */
export async function POST(req) {
  const auth = await requireUser(req);
  if (!auth) return json({ error: 'Not signed in.' }, 401);
  const profile = await getProfile(auth.supabase, auth.user.id);
  if (!profile.stripe_customer_id) return json({ error: 'No subscription found.' }, 404);
  try {
    const session = await getStripe().billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${siteUrl(req)}/profile`,
    });
    return json({ url: session.url });
  } catch (e) {
    console.error('portal failed', e);
    return json({ error: 'Could not open your billing page.' }, 500);
  }
}
