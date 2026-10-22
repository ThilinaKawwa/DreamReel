# Dream Guru V2: Guru-first Dream Reel

Dream Reel's first screen is now Orin, a dream companion that remembers your dreams. Dream Reels are still available, but only when the dreamer asks Orin to visualize a dream.

## Flow

```
open app → Orin ("What do you remember?") → tap mic (or "Prefer to type?")
   → speak the dream, however messily
   → the dream is SAVED immediately (dreams.status = 'saved', source = 'guru', private)
   → Orin reflects back what he heard; he may ask up to 2 useful questions
   → each answer is added to the same dream
   → memory is built in the background
     (structured record → recurring people/places → related dreams → patterns)
   → later turns retrieve only the relevant earlier dreams
   → occasionally: "Would you like me to visualize this dream?" → the existing Dream Director
```

## Where things live

| Concern | File |
|---|---|
| Conversation turn (voice + text, one endpoint) | `app/app/api/guru/talk/route.js` |
| Intent rules (no AI call) | `app/lib/orin/intent.js` |
| Orin's personality and per-intent instructions | `app/lib/orin/persona.js` |
| The compact `GuruContext` sent to the model | `app/lib/orin/context.js` |
| Reply checks: no invented past, only known citations, question budget, visualize offer | `app/lib/orin/guards.js` |
| Allowance and cost rows | `app/lib/orin/usage.js` |
| Level 1: the memory of one dream (extraction prompt and validation) | `app/lib/memory/normalize.js` |
| Level 2: entities and how they are matched | `app/lib/memory/entities.js` |
| Retrieval and archive search | `app/lib/memory/search.js` |
| Level 3: patterns and related / possibly recurring dreams | `app/lib/memory/patterns.js` |
| Database reads and writes for all three levels | `app/lib/memory/store.js` |
| Background build and retry | `app/lib/memory/process.js`, `app/app/api/memory/sync` |
| My Dreams, dream detail, Insights | `app/app/dreams`, `app/components/DreamMemory.js`, `app/app/insights` |
| Visualize (reuses the Dream Director) | `app/app/api/dreams/[id]/visualize/route.js`, `startCinematic()` in `app/lib/cinema/start.js` |

## Database

The migration is `app/supabase/migrations/20261022_guru_memory.sql`. It only adds things and is safe to run again. It must run after the earlier migrations, in this order:

1. `20261012_guru_and_premium.sql`
2. `20261015_reels_v1.sql`
3. `20261015_privacy_lockdown.sql`
4. `20261017_dream_director.sql`
5. `20261022_guru_memory.sql`

As of 2026-10-22, the live DreamReel database had **not** run steps 1–4. It has no `profiles`, `guru_messages`, `dream_readings`, `reel_credits` or `dream-media` bucket. It also still has the old "read own *or public*" policy, with `is_public` defaulting to `true`.

## Retrieval and the embeddings upgrade path

V2 ranks the dreamer's own stored memories with these signals:

- entity overlap, for people, places, objects and creatures;
- literal motifs, such as water, flying or being late;
- keywords;
- recency;
- time filters, such as "this month".

Matching on the motifs and keywords also uses the Postgres full-text index on `dream_memories.search`. Every query is filtered by the signed-in user's id, with row-level security as a second check.

This is predictable and cheap, and it is tested. pgvector (0.8.2) is available on the project. When there are enough dreams for meaning-based search to matter:

1. Add `embedding vector(1536)` to `dream_memories`.
2. Fill it in `buildMemory()` only when `source_hash` changes.
3. Add `similarity` as one more term in `rankMemories()`, alongside the others rather than replacing them.

## Deletion and editing

- Deleting a dream cascades to:
  - its memory;
  - its entity appearances;
  - its related-dream links;
  - its Guru messages.

  Conversations are detached from it. Before the delete returns, `forgetDream()` removes entities nothing refers to any more and rebuilds patterns.
- Entity counts are never stored. They are always counted live (`dream_entity_stats`).
- Earlier Orin replies that cited a deleted dream are left out of his context.
- Editing a dream's words marks its memory out of date. The memory is rebuilt from the new words; the `source_hash` changes, so nothing stale is kept.

## Tests

| Command | What it checks |
|---|---|
| `npm test` | Unit tests: intent, entities, memory validation, retrieval, patterns, context, guards, plans, plus scenarios A–F on stored-memory logic. |
| `npm run test:sql` | All migrations on PGlite, as two different users: privacy, cascades, live counts, re-runnable. |
| `npm run test:integration` | `PG_HOST=… PG_PORT=… PGRST_BIN=…` The real memory code and the real API routes (`next dev`) on a real Postgres through PostgREST. Supabase Auth and OpenAI are **stand-ins**, so it verifies saving, conversation state, retrieval, privacy, allowance and deletion, not the quality of Orin's answers. |
| `node test/ui-screens.mjs` | Phone-size screenshots of every new screen on the same test setup. |
