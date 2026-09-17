// The visual "look" of a reel. The suffix is added to every image prompt so
// all five pictures in one dream match each other.
export const STYLES = {
  dusk: {
    label: 'Painted Dusk',
    blurb: 'Warm & painterly',
    suffix:
      'hand-painted animation background art, warm dusk light, soft gouache textures, lush detail, gentle nostalgia, wide shot, no text, no watermark',
  },
  neon: {
    label: 'Biolume Neon',
    blurb: 'Deep glow',
    suffix:
      'bioluminescent night scene, deep blues and blacks with glowing magenta and cyan light, volumetric haze, cinematic, no text, no watermark',
  },
  retro: {
    label: 'Cosmic Retro',
    blurb: '70s starlight',
    suffix:
      '1970s science-fiction paperback cover art, airbrushed starfields, warm amber and violet palette, film grain, dreamlike, no text, no watermark',
  },
};

export const DEFAULT_STYLE = 'dusk';
