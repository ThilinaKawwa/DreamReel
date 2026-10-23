# Dream Reel

Tell it your dream in the morning. It paints five pictures and plays them back as a short reel you can share.

## How it works (plain English)
1. You tap the button and talk (or type). The browser records the audio.
2. The audio goes to `/api/dreams` on the server, which:
   - turns the voice into text (OpenAI),
   - splits it into 5 scenes with captions (OpenAI),
   - paints one picture per scene (fal.ai, Flux),
   - copies the pictures into Supabase storage and saves the dream.
3. You're sent to `/d/<id>` where the reel plays. That link is shareable.
4. `/library` shows all your dreams.

Visitors get an instant anonymous account, so there's no sign-up wall.

## Dream Director (cinematic films, `dream-director-v2`)

1. **Understand**: GPT turns the spoken dream into a *DreamBible*. It records characters, places and objects with fixed IDs and locked descriptions, the order of events, and continuity rules. The original words are stored untouched.
2. **Storyboard**: 3 shots on the free trial, 5 on Premium. Each shot has one motion idea and plain "remembered" narration; over-written lines are replaced with the dreamer's own words.
3. **Reference pack**: a front view for every on-screen character. Characters in 2 or more shots also get a three-quarter view, made *from* the front view. Places that appear in 2 or more shots get one reference. Objects that appear in 2 or more shots get a front view plus a second angle made from it, because a Kling O1 identity element needs a front image and at least one more reference (`lib/director/routing.js`).
4. **Keyframes**: each shot's first frame is made *from* those references (`nano-banana/edit`).
5. **Video, routed per shot**:
   - Shots with a recurring person or object use **Kling O1 reference-to-video**, which takes the character pack as identity "elements".
   - Purely scenic shots use **Kling 2.5 Turbo Pro image-to-video**.
   - Only a failed shot is retried.
6. **Check and edit**: clips that are broken, black, frozen or too short are rejected. If shots are missing, the person sees *"We couldn't finish the cinematic version of this dream"* with a retry. A slideshow is never shown as if it were the film. Set `REEL_DEBUG_FALLBACK=true` to also save a still-image version privately, for debugging only.

All Dream Director media (references, keyframes, clips, narration, final film) goes to the **private** `dream-media` bucket. That bucket has no browser access at all; the server checks ownership and issues short-lived signed links.

### Buckets
| Bucket | Public? | What's in it |
|---|---|---|
| `dream-media` | **Private, server-only** | Everything made by Dream Director. Owners get signed links: 30 min (free) or 2 h (paid) for the film, 1 h for pictures. Shared dream pages get 24 h links to keyframes only. |
| `dream-videos` | Private, owner-readable | Older picture-renderer films (V1). |
| `reels` | Public (not listable after the privacy migration) | Older V1 pictures only. Nothing new is written here. |

### Environments
Each production row records the environment that created it (`production`, `preview` or `development`). The background worker only processes rows from its own environment.
- **Preview** deployments call their own deployment URL and never a production host.
- **Local development** runs the work in the same process unless `REEL_WORKER_URL` points at localhost.
- See `lib/cinema/env.js` and `test/hardening.test.mjs`.

### Access (all decided on the server: `lib/access-config.js` and `lib/entitlements.js`)
| | Free trial | Premium |
|---|---|---|
| Cinematic Dream Reels | **1 in total** (`FREE_TRIAL_REELS`) | **4 per UK calendar month** (`PREMIUM_MONTHLY_REELS`) |
| Shots per film | 3 | 5 |
| Download the MP4 | No (watch in the app) | Yes |
| Share a link | Yes (`FREE_CAN_SHARE_LINK`) | Yes |
| Share the file | No (`FREE_CAN_SHARE_FILE`) | Yes |
| Dream Guru | Locked preview | Yes |

Credits are claimed in the database (`reel_credits`). Retrying the same dream never uses a second credit. If no usable film is produced, the credit is given back, at most 2 times for the trial and 3 times per month for Premium. Deleting a dream never gives its credit back.

### Cost safety
- **Daily budget**: `REEL_DAILY_BUDGET_USD` (default 25) is reserved in the database *before* any money is spent, and the check is safe when several films start at once. Each retry reserves its own share.
- **Admin view**: accounts listed in `ADMIN_USER_IDS` can open `GET /api/admin/costs`. It shows today's spent, reserved and remaining budget and the number of blocked films, plus per-film cost by part, models used, and per-shot provider and attempts.

### Costs per film (list prices, checked 2026-10-16)
| Film | Estimated AI cost |
|---|---|
| Free, 3 shots (2 with people, 1 scenic) | about $1.75 |
| Free, 3 scenic shots | about $1.21 |
| Premium, 5 shots (3 with people) | about $2.78 |
| Premium, plus one failed-shot retry | about $3.38 |
| Premium, worst reasonable case | about $5.60 |

The list prices used are Kling 2.5 Turbo Pro $0.07/s, Kling O1 reference $0.112/s and nano-banana $0.04/image. OpenAI is estimated at about $0.04 per film: gpt-transcribe $0.0045/min, gpt-realtime-2.1-mini speech about $0.024/min, gpt-4.1 about $0.015 per call. Sources, check dates and assumptions are in `lib/cinema/costs.js`. Override any price with the `PRICE_*` variables if the providers change them. Each film records one usage line per provider call (provider, model, billing unit, quantity, estimated cost), and `/api/admin/costs` sums them.

### Audio models
| Job | Model | How it's called |
|---|---|---|
| Recording → text | `gpt-transcribe` | `/v1/audio/transcriptions` (same as before) |
| Narration and Orin's voice | `gpt-realtime-2.1-mini` | `/v1/audio/speech` (WAV). Only if OpenAI rejects the model there: a short server-side Realtime session per line, with a word-for-word check. `TTS_TRANSPORT=speech\|realtime` forces one path. |
| Temporary fallback | `gpt-4o-mini-tts` | `/v1/audio/speech`, only if the main path fails. Every use is recorded (`tts_fallback_used` on each narration line and Guru reply). OpenAI removes it on 2027-01-06. |

**Provider contract test (admins):** open `/admin/contract-test` while signed in as an `ADMIN_USER_IDS` account. It runs one speech + one transcription request (~$0.01) and one 5-second Kling O1 clip (~$0.56) and shows the raw results.

## Dream Reel films (shareable video)
After a dream is painted, its owner's page automatically makes a **film**: a 1080×1920 MP4 (15–35 s) for TikTok, Reels and Shorts.
1. A short, faithful narration is written (one line per scene) and read aloud (OpenAI).
2. Each picture gets a slow, eased camera move; scenes cross-fade; captions use the app's fonts.
3. An original ambient track (`assets/music`, composed by `scripts/compose-music.py`) plays under the voice, ducking when it speaks.
4. A quiet "Dream Reel" footer and a 2-second end card with your web address (`NEXT_PUBLIC_SITE_URL`).

It renders on Vercel with ffmpeg in about a minute, in the background (`/api/dreams/[id]/reel`). Progress is saved per stage in `dream_reels`; the film, poster and voice are stored in the **private** `dream-videos` bucket and only ever reach their owner through 2-hour signed links. Nothing is rendered twice. If narration fails, the film is still made with music and captions.

Tests: `npm test` (fast unit tests) and `npm run test:render` (makes a real film offline, ~1 min).

## Setting up films (one time, in this order)
1. Supabase → SQL Editor → run `supabase/migrations/20261015_reels_v1.sql` (adds only new things).
2. Deploy this code to Vercel.
3. Supabase → SQL Editor → run `supabase/migrations/20261015_privacy_lockdown.sql` (makes dreams private; strangers can no longer list dreams or files).

Funnel numbers: Supabase → SQL Editor → `select * from funnel_daily;`

## Free vs Premium (switched off for now: `NEXT_PUBLIC_PREMIUM_ENABLED`)
- **Free:** five painted pictures with a slow zoom, read aloud by a soft narrator, with gentle ambient music (made in the browser — no cost).
- **Premium (monthly, via Stripe):**
  - **Moving reels** — every scene is animated into a real video clip (fal.ai, Kling). Takes 1–3 minutes after the pictures; the reel swaps the clips in as they finish.
  - **Orin, the Dream Guru** — a wise, psychology-grounded mystic who reads each dream through the world's great traditions (psychology, Islamic, Christian, Hindu, Buddhist, Chinese — chosen in Profile).
  - **Talk to Orin** by typing or tap-to-talk; he answers out loud in a deep, calm voice.
  - **Memory** — Orin sees the summaries and symbols of earlier dreams and points out real patterns.
  - **Orin's summary** as the closing card of the owner's reel (never shown on shared links).

Readings and conversations are private to the dreamer, even when the reel itself is shared.

## Settings needed in Vercel (Settings → Environment Variables)
- `OPENAI_API_KEY`, `FAL_KEY`
- For Premium: `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SITE_URL`
- Optional: see `.env.example` (daily limits, voices, models)

## Turning on Premium (one time)
1. **Database:** Supabase → SQL Editor → paste and run `supabase/migrations/20261012_guru_and_premium.sql`.
2. **Stripe product:** Stripe → Product catalogue → *Add product* "Dream Reel Premium", recurring **monthly** price in **GBP** (e.g. £3.99). Copy the `price_…` id into `STRIPE_PRICE_ID`.
3. **Stripe webhook:** Stripe → Developers → Webhooks → *Add endpoint* `https://YOUR-SITE/api/billing/webhook`, events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
4. **Billing portal:** Stripe → Settings → Billing → Customer portal → turn on (lets people cancel themselves).
5. **Supabase email:** Authentication → Providers → Email ON (so people can save their account with an email and keep Premium on a new phone).
6. Redeploy on Vercel. Test with Stripe test mode and card `4242 4242 4242 4242` first.

## Costs to keep an eye on (approximate)
- Free reel: ~£0.02 (pictures + narration).
- Premium moving reel: ~£1–2 (five 5-second AI clips) — the main cost; limit with `PREMIUM_DAILY_LIMIT`.
- Guru reading: ~£0.01–0.03. Each chat answer ~£0.01, plus ~£0.01 when spoken.

## One setting needed in Supabase
Authentication → Sign In / Providers → turn ON "Allow anonymous sign-ins".

## Run on your own computer (optional)
```
npm install
cp .env.example .env.local   # then fill in the two keys
npm run dev
```
