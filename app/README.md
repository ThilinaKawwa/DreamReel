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

## Settings needed in Vercel (Settings → Environment Variables)
- `OPENAI_API_KEY`
- `FAL_KEY`
- optional `DAILY_LIMIT` (default 3 dreams per person per day)

## One setting needed in Supabase
Authentication → Sign In / Providers → turn ON "Allow anonymous sign-ins".

## Run on your own computer (optional)
```
npm install
cp .env.example .env.local   # then fill in the two keys
npm run dev
```
