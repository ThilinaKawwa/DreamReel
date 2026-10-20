# DreamReel clip pipeline: design doc

## Summary
At the moment a dream is only a set of 5 Flux images (576x1024, `portrait_16_9`) plus captions in the `dreams.scenes` row. `Player.js` animates them live on a canvas. That gives users nothing to download, no music, and nothing they can share to TikTok, Instagram or WhatsApp.

**Recommendation:** add a second step that runs on the server after the images are ready. A new Vercel function (`/api/dreams/[id]/render`, Node runtime, `maxDuration` 300) does three things:
- draws each frame with `@napi-rs/canvas`, using the same Ken Burns and caption code as `Player.js`;
- pipes the frames into a bundled `ffmpeg-static` together with a music track from a licensed library;
- uploads `reel.mp4` and `poster.jpg` to the `reels` bucket.

The page keeps playing the canvas version until the MP4 is ready, then offers Download and Share.

Expected cost per clip is about $0.01–0.02 in compute and nothing for music in v1. Expected wait is 20–60s after the images finish.

**Options compared:**

| Option | Latency | Cost per clip | Complexity | Main way it fails |
|---|---|---|---|---|
| **A. Server FFmpeg in a Vercel function (recommended)** | 20–60s | about $0.01 compute | Medium: native binaries need bundling | Function timeout or memory limit; fixed by a retry |
| B. Export in the browser (WebCodecs or MediaRecorder) | Real time on the device | $0 | Medium | Output depends on the phone: Safari and iOS MediaRecorder give inconsistent containers, there is no faststart, low-end phones stutter, and a backgrounded tab kills it. It also only works for the owner while the page is open. |
| C. Remotion Lambda | 10–30s | about $0.001 AWS plus a $0.01/render Automators licence (if 4+ staff, $100/mo minimum) | High: a second cloud (AWS account, S3, IAM) | Running and paying for two platforms |

The hosted fal `ffmpeg-api/compose` endpoint ($0.0002 per second of output) could replace the binary. It has not been confirmed that it supports per-frame zoom or burned-in captions, so treat it only as a fallback for joining music to video.

Vercel limits relevant to option A (official docs, updated 2026-02): functions on Hobby can now run up to 300s, and on Pro up to 800s. Memory is 2 GB on Hobby and 4 GB on Pro. That is enough for a 25s 1080p encode. The current 60s `maxDuration` on `/api/dreams` cannot hold an encode as well, so rendering has to be a separate invocation.

## Recommended architecture
```
[Client /create] --POST /api/dreams--> transcribe -> scenes -> 5x Flux -> store imgs
                                        dreams.status = ready, video_status = queued
       |                                         |
       |  (client fires immediately,             | (fallback: cron sweeps queued/stale rows)
       v   with user JWT)                        v
POST /api/dreams/:id/render  (maxDuration 300, idempotent)
  1. claim: UPDATE ... SET video_status='rendering', render_attempts+1
            WHERE id=:id AND video_status IN ('queued','failed') AND attempts<3
            (0 rows -> 202 already running/done)
  2. moderation: OpenAI moderation on title+captions (burned into a file)
  3. fetch 5 images + pick music track (style -> library list, seeded by dream id)
  4. render: napi-canvas drawFrame(t) x 750 -> raw RGBA pipe -> ffmpeg
            + audio: trim to 25s, afade in/out, loudnorm -> AAC
  5. upload {uid}/{id}/reel-v1.mp4, poster-v1.jpg (upsert, contentType set)
  6. UPDATE video_status='ready', video_path, poster_path, duration_ms
     on error: video_status='failed', video_error
       |
       v
[/d/:id] polls the row every 3s while queued/rendering (or Supabase Realtime)
   -> canvas Player meanwhile -> swaps to <video poster playsinline> when ready
   -> Share: navigator.share({files:[mp4]}) | fallback: link + ?download=
```

**Code to share between client and server.** Move the drawing code out of `Player.js` into `lib/reel.js`, as a pure function `drawFrame(ctx, images, tMs, {W,H,scenes})`. It covers cover-fit, zoom from 1.04 to 1.14, horizontal drift, the bottom shade, the fade to black, and caption text with wrapping. This removes the captions' current dependence on the DOM. The browser `Player` and the server renderer then import the same file, so the downloaded MP4 looks the same as the in-app reel. The server also draws the watermark and date, which are DOM overlays today. Progress bars are drawn only in the app, never into the file.

**Auth and storage.** The function runs as the user with their JWT, like the current route, so existing RLS on `reels/{uid}/...` still applies. Retries started by cron need `SUPABASE_SERVICE_ROLE_KEY`, kept server-only.

**Bundling.** Set `serverExternalPackages: ['@napi-rs/canvas','ffmpeg-static']` and use `outputFileTracingIncludes` for the ffmpeg binary, one TTF font, and `/music/*`. Keep the function under Vercel's bundle-size limit; the ffmpeg-static binary alone is about 75 MB.

## Data model changes
New columns on `dreams`:
- `video_status text default 'none'`: one of none, queued, rendering, ready, failed. Kept separate from `status`, so playing the images never waits on the encode.
- `video_path text`, `poster_path text`: storage paths, not URLs.
- `video_duration_ms int`, `video_bytes int`
- `music_track text`: library ID, needed for licence attribution and audit.
- `render_attempts int default 0`, `render_started_at timestamptz`, `video_error text`
- `render_version int default 1`: bump it to re-render everything with a new look. It is also part of the file name, which busts the CDN cache.

Add an index on `(video_status, render_started_at)` for the cron sweep. A row stuck in `rendering` for more than 6 minutes is treated as dead and set back to `queued`.

## Encode spec
- **Container:** MP4 with `-movflags +faststart`.
- **Video:** H.264 (libx264), High profile, level 4.1, `yuv420p`, 1080x1920, 30 fps constant frame rate.
  - Quality: `-preset veryfast -crf 21 -maxrate 6M -bufsize 12M`.
  - Keyframes: GOP 60 (2s) with `-g 60 -keyint_min 30`; leave scene-cut detection on.
  - Colour tags: `-colorspace bt709 -color_primaries bt709 -color_trc bt709`.
  - The source images are 576x1024. Upscale with Lanczos inside the canvas renderer. Rendering at 720x1280 is a valid option if encode time is tight.
- **Timeline:** 5 scenes x 5.0s = 25.0s. Optional 1.5s end card (title + "Dream Reel") for a total of 26.5s. Captions fade in 250ms after each cut, as the app does now.
- **Audio:** AAC-LC, 48 kHz, stereo, 128 kbps.
  - Trim the track to the video length; fade in 0.5s and out 1.5s.
  - Loudness: `loudnorm=I=-14:TP=-1.5:LRA=11`, which matches the social platforms' targets. Pre-normalise the library tracks so this pass is cheap.
- **Expected size:** 10–18 MB.
- **Poster:** JPEG 1080x1920 at q≈85, taken from frame 0.5s of scene 1. Also use it for `og:image`, and add `og:video` pointing at the MP4.
- **Delivery:** public URL from the Supabase `reels` bucket, CDN-cached, `cache-control: public, max-age=31536000, immutable`. File names include the version, so caching forever is safe.

## Rollout steps (in order)
1. Move the drawing code into `lib/reel.js`, with no change to what users see, and check `Player` renders the same as before.
2. Run the DB migration for the new columns. Add `video_status='queued'` to the success branch of `/api/dreams`.
3. Collect the music library: 3–5 instrumental tracks per style (dusk, neon, retro), cleared for use in user-generated videos shared on social. Pre-trim them to 30s, normalise them, and record each track's licence in `music/manifest.json`.
4. Build `/api/dreams/[id]/render` with the claim step, render, upload and failure path. Test locally, then on a Vercel preview, timing the encode and peak memory at 1080p on the actual plan tier.
5. In `create/page.js`, call the render endpoint as soon as `/api/dreams` returns. In `DreamView`, poll the row and swap to `<video>` when ready. Add Download (`getPublicUrl(path,{download:'dream-reel.mp4'})`) and Share (`navigator.canShare({files})` first, link-share as fallback).
6. Add a cron job (Vercel Cron, every 5 minutes) to re-queue stale or failed rows with `attempts < 3`, using the service-role key.
7. Backfill existing `ready` dreams in small batches.
8. Later: offer generated music as a premium option, for example fal Lyria 2 (about $0.10 per 30s) or Stable Audio 2.5 (about $0.20 per clip), after checking each model's output licence.

## Open questions
- Which plan are you on, Vercel Hobby or Pro, and Supabase Free or Pro? Encode headroom and egress cost both depend on it.
- Generated or licensed music for v1? Recommended: a licensed library. It costs nothing, adds no wait, and its licence is known.
- Should the MP4 carry the watermark and date (good for growth), and should private dreams get a video at all?
- Should a voice-over be offered, either the user's own recording or TTS of the captions? The recording is currently thrown away after transcription.
- Should the render count against `DAILY_LIMIT`, or be included in the cost of creating a dream?

## Risks
- **Supabase egress:** about 15 MB per view. On the Free plan's roughly 5 GB a month, that runs out after about 350 full views. Pro allows 250 GB, then about $0.09/GB. Mitigate by showing the poster and loading the video only on play (`preload="none"`), and by serving it through a CDN in front of Storage if traffic grows.
- **Encode time:** generating 750 frames at 1080p with canvas plus x264 on 1–2 vCPU may take 40–90s. Mitigate with `veryfast`, 720p as a fallback, and a 300s budget.
- **Native binaries on Vercel:** bundle size and file tracing for ffmpeg and canvas are the most likely things to break. Check this on a preview deploy first.
- **Content safety:** captions burned into a file can be shared and are permanent. Run moderation on the text. A black image from the Flux safety checker would currently end up in the MP4: detect it and re-roll or skip that scene.
- **Music licensing:** a library licence that excludes social use, or generated music with unclear rights, could get shared clips muted or taken down. Keep `music_track` on every row so tracks can be audited and replaced.
- **Duplicate renders:** the client trigger and cron can race. The claim `UPDATE` and versioned `upsert` paths make this safe, but it needs testing.
- **Upload size:** check the bucket's per-file limit, which defaults to 50 MB. At these settings the MP4 should stay under 20 MB.

## Sources
Pricing and limits come from search-result summaries, because direct fetches of vercel.com and fal.ai were blocked. Check them against the live pages.
- [Vercel function limits](https://vercel.com/docs/functions/limitations)
- [fal text-to-music pricing](https://fal.ai/learn/tools/best-text-to-music-apis-2026)
- [fal ffmpeg-api compose](https://fal.ai/models/fal-ai/ffmpeg-api/compose/api)
- [Remotion pricing](https://www.remotion.dev/docs/pricing)
- [Remotion Lambda cost example](https://remotion.dev/docs/lambda/cost-example)
- [Supabase pricing overview (third-party)](https://makerkit.dev/blog/saas/supabase-pricing)
