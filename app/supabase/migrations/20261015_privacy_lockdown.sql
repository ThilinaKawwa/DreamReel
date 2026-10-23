-- Privacy lockdown. Run AFTER the new code is live on Vercel (it reads shared dreams
-- through get_shared_dream(), created in 20261015_reels_v1.sql).
--
-- Fixes found in the audit:
--  * Anyone with the public app key could LIST every public dream, including transcripts.
--  * Anyone could LIST every file in the public `reels` bucket.

-- 1. Dreams are private by default. Sharing a link is an explicit choice in the app.
alter table public.dreams alter column is_public set default false;

-- 2. Only the owner can read their dreams directly. Shared dreams are read one at a
--    time by id through get_shared_dream(), which never returns the transcript.
drop policy if exists "dreams: read own or public" on public.dreams;
drop policy if exists "dreams: read own" on public.dreams;
create policy "dreams: read own" on public.dreams
  for select using (auth.uid() = user_id);

-- 3. Pictures stay viewable by their direct link (the bucket remains public so reels and
--    shared pages keep working), but the bucket can no longer be listed by strangers.
drop policy if exists "reels: public read" on storage.objects;
drop policy if exists "reels: owner read" on storage.objects;
create policy "reels: owner read" on storage.objects
  for select using (bucket_id = 'reels' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "reels: users update own" on storage.objects;
create policy "reels: users update own" on storage.objects
  for update using (bucket_id = 'reels' and (storage.foldername(name))[1] = auth.uid()::text);

-- 4. OPTIONAL — make every existing dream private too (their old share links stop working).
--    Recommended before inviting testers. Remove the two dashes to run it:
-- update public.dreams set is_public = false where is_public = true;
