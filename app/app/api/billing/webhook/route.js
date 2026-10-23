import { getStripe, syncSubscription } from '@/lib/stripe';

export const runtime = 'nodejs';

const HANDLED = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
]);

/**
 * Stripe calls this after payments and subscription changes.
 * In Stripe → Developers → Webhooks, point an endpoint at /api/billing/webhook
 * and put its signing secret in STRIPE_WEBHOOK_SECRET.
 */
export async function POST(req) {
  const stripe = getStripe();
  const body = await req.text();
  let event;
  try {
    event = stripe.webhooks.constructEvent(body, req.headers.get('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('webhook signature failed', e?.message);
    return new Response('Bad signature', { status: 400 });
  }
  if (!HANDLED.has(event.type)) return new Response('ignored');

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session.mode === 'subscription' && session.subscription) {
        const sub = await stripe.subscriptions.retrieve(
          typeof session.subscription === 'string' ? session.subscription : session.subscription.id
        );
        if (!sub.metadata?.user_id && session.client_reference_id) sub.metadata = { ...sub.metadata, user_id: session.client_reference_id };
        await syncSubscription(sub);
      }
    } else {
      await syncSubscription(event.data.object);
    }
    return new Response('ok');
  } catch (e) {
    console.error('webhook handling failed', event.type, e);
    // 500 makes Stripe retry later.
    return new Response('error', { status: 500 });
  }
}
