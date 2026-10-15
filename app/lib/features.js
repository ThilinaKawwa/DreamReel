// Feature switches. Premium (Guru, subscription, AI video clips) is built but kept off
// until the core reel loop is proven. Turn on with NEXT_PUBLIC_PREMIUM_ENABLED=true.
export const PREMIUM_ENABLED = process.env.NEXT_PUBLIC_PREMIUM_ENABLED === 'true';
