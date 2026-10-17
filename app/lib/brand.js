// One place for the product's name, words and web address.
// Moving to a new domain = set NEXT_PUBLIC_SITE_URL in Vercel. Nothing else.

export const BRAND = {
  name: 'Dream Reel',
  promise: 'Dreams disappear. Dream Reel lets you keep them.',
  tagline: ['Dreams disappear.', 'Keep yours.'],
  footer: 'Dream Reel',
};

/** The public web address, e.g. "https://dreamreel.app" (no trailing slash). */
export function siteUrl() {
  const raw = process.env.NEXT_PUBLIC_SITE_URL || '';
  return raw.replace(/\/+$/, '');
}

/** "dreamreel.app" for the end card of every reel — empty until a site URL is set. */
export function siteDomain() {
  try {
    const host = new URL(siteUrl()).host;
    return host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** A tidy, safe filename: "dream-reel-ocean-in-the-sky.mp4" */
export function reelFilename(title) {
  const slug = String(title || 'my dream')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'my-dream';
  return `dream-reel-${slug}.mp4`;
}
