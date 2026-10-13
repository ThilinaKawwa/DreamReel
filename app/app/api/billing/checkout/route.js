import { json, requireUser } from '@/lib/server';
import { getStripe, customerFor, siteUrl } from '@/lib/stripe';

export const runtime = 'nodejs';

/** Starts Stripe Checkout for the monthly Premium plan. Returns { url } to redirect to. */
export async function POST(req) {
  const auth = await requireUser(req);
  if (!auth) return json({ error: 'Not signed in.' }, 401);
  if (!process.env.STRIPE_PRICE_ID) return json({ error: 'Payments are not set up yet (STRIPE_PRICE_ID).' }, 500);

  const { returnTo } = await req.json().catch(() => ({}));
  const back = typeof returnTo === 'string' && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/profile';
  const origin = siteUrl(req);

  try {
    const customer = await customerFor(auth.user);
    const session = await getStripe().checkout.sessions.create({
      mode: 'subscription',
      customer,
      client_reference_id: auth.user.id,
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      subscription_data: { metadata: { user_id: auth.user.id } },
      allow_promotion_codes: true,
      success_url: `${origin}${back}${back.includes('?') ? '&' : '?'}upgraded=1`,
      cancel_url: `${origin}${back}`,
    });
    return json({ url: session.url });
  } catch (e) {
    console.error('checkout failed', e);
    return json({ error: 'Could not open checkout. Please try again.' }, 500);
  }
}
