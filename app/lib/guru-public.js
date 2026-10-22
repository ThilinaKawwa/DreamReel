// Safe to use in the browser. The Guru's instructions live in lib/guru.js (server only).
export const GURU_NAME = 'Orin';
export const PREMIUM_PRICE_LABEL = process.env.NEXT_PUBLIC_PREMIUM_PRICE_LABEL || '£3.99 a month';

export const TRADITION_OPTIONS = [
  { key: 'blend', label: 'None in particular', blurb: 'Grounded in your own details and feelings (default)' },
  { key: 'psychology', label: 'Psychology', blurb: 'Jung, emotion and modern dream science' },
  { key: 'islamic', label: 'Islamic', blurb: 'Ibn Sirin and the classical scholars' },
  { key: 'christian', label: 'Christian', blurb: 'Biblical dreams and contemplative wisdom' },
  { key: 'hindu', label: 'Hindu', blurb: 'Swapna Shastra and the Upanishads' },
  { key: 'buddhist', label: 'Buddhist', blurb: 'Dream yoga, impermanence and the mind' },
  { key: 'chinese', label: 'Chinese', blurb: "The Duke of Zhou's dream book" },
];
