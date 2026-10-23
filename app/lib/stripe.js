import Stripe from 'stripe';
import { getServiceSupabase } from '@/lib/server';

let stripe;
export function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set');
  if (!stripe) stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return stripe;
}

export function siteUrl(req) {
  return process.env.NEXT_PUBLIC_SITE_URL || req.headers.get('origin') || new URL(req.url).origin;
}

/** Finds (or creates) the Stripe customer for a Dream Reel user. */
export async function customerFor(user) {
  const admin = getServiceSupabase();
  const { data: profile } = await admin.from('profiles').select('stripe_customer_id').eq('user_id', user.id).maybeSingle();
  if (profile?.stripe_customer_id) return profile.stripe_customer_id;

  const customer = await getStripe().customers.create({
    email: user.email || undefined,
    metadata: { user_id: user.id },
  });
  await admin.from('profiles').upsert(
    { user_id: user.id, stripe_customer_id: customer.id, updated_at: new Date().toISOString() },
    { onConflict: 'user_id' }
  );
  return customer.id;
}

/** Copies a Stripe subscription's state onto the person's profile. */
export async function syncSubscription(sub) {
  const admin = getServiceSupabase();
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
  let userId = sub.metadata?.user_id;
  if (!userId && customerId) {
    const { data } = await admin.from('profiles').select('user_id').eq('stripe_customer_id', customerId).maybeSingle();
    userId = data?.user_id;
  }
  if (!userId) throw new Error(`No Dream Reel user for Stripe customer ${customerId}`);

  const periodEnd = sub.items?.data?.[0]?.current_period_end ?? sub.current_period_end;
  const active = sub.status === 'active' || sub.status === 'trialing';

  // An old, cancelled subscription must not switch off a newer active one.
  const { data: current } = await admin.from('profiles')
    .select('stripe_subscription_id, subscription_status').eq('user_id', userId).maybeSingle();
  if (!active && current?.stripe_subscription_id && current.stripe_subscription_id !== sub.id
      && ['active', 'trialing'].includes(current.subscription_status)) return;
  const { error } = await admin.from('profiles').upsert(
    {
      user_id: userId,
      plan: active ? 'premium' : 'free',
      subscription_status: sub.status,
      stripe_customer_id: customerId,
      stripe_subscription_id: sub.id,
      current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' }
  );
  if (error) throw error;
}
