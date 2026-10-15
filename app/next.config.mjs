/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // ffmpeg is a native program: load it from node_modules at run time, don't bundle it.
  serverExternalPackages: ['ffmpeg-static'],
  // Ship the ffmpeg binary, soundtracks and fonts with the reel route only.
  outputFileTracingIncludes: {
    '/api/dreams/\\[id\\]/reel': [
      './node_modules/ffmpeg-static/ffmpeg',
      './node_modules/ffmpeg-static/package.json',
      './node_modules/ffmpeg-static/index.js',
      './assets/music/**/*',
      './assets/fonts/**/*',
    ],
  },
};

export default nextConfig;
