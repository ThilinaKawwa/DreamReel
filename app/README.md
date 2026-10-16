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
