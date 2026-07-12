# CLAUDE.md — src/workflows/movies/

The folder is `movies`; the workflow's registered name is **`movie-recommendations`** — distinct
names, same thing. Referenced elsewhere as either.

**T468 split note:** this workflow used to also run a deterministic franchise-gap audit
(`franchise-gaps`) and push a single combined monthly digest. That audit now lives in the sibling
`missing-movies` workflow (own folder, own Plex snapshot, weekly cadence) — see
`src/workflows/missing-movies/CLAUDE.md` and `.harness/worklog/T467.md` for the split's design
record. This workflow is now RECOMMENDATIONS-ONLY.

## What it does

Monthly audit of the owner's Plex movie library that surfaces taste-based RECOMMENDATIONS
(subjective) — 8 parallel Claude recommender branches propose picks from a stratified library
sample, merged with code-side TMDB verification, cross-branch dedup, and per-genre balancing.

Dedupes per TMDB id so nothing repeats across runs; the owner can ignore-to-suppress a
recommendation from the dashboard.

## DAG

```
movie-snapshot ──┬─→ rec-random-1 ─┐
                  ├─→ rec-random-2 ─┤
                  ├─→ rec-random-3 ─┤
                  ├─→ rec-auteur ───┼─→ rec-merge ──→ movie-recs-notify
                  ├─→ rec-canon ────┤
                  ├─→ rec-thin-genre┤
                  ├─→ rec-older-era┤
                  └─→ rec-world-cinema┘
```

`maxConcurrency: 4` — all 8 recommender branches depend ONLY on `movie-snapshot`, so once it
finishes they run up to 4 at a time instead of sequentially (each branch is its own child process
invoking the Claude CLI; the cap protects the Mac Mini while collapsing wall-time). Every branch
routes its Claude calls through the shared `claude-cli` service (`callService`), so the rate limit
+ monthly quota are enforced GLOBALLY regardless of concurrency — the service is the spend
governor, not the cap. Scheduled monthly (`'0 9 1 * *'`, 1st at 09:00).

**Not limitable** — no member declares `inputKeys()`. Inputs are discovered live from Plex each
run, not a static file. `movie-snapshot` RE-COMPUTES FRESH every run (no skip-if-done); only
`movie-recs-notify` uses the `work_items` ledger, and there it's a "have I already recommended
this?" / "has the owner ignored it?" log, not a work-done ledger — so a film is recommended at
most once ever and an ignored one is suppressed forever.

## Stage 1 — `movie-snapshot`

Reads Plex library section `PLEX_MOVIE_SECTION` (default `4`, the owner's "Movies") via the shared
`plexGet` (`src/core/plex-client.ts`), matching each movie's `tmdb://` GUID (never guessed — a
movie with no `tmdb://` GUID is flagged and excluded from franchise-gap checking, listed in the
run's logs). Writes:
- `data/out/snapshot.json` — every movie + its owned-set membership.
- `data/out/taste-profile.json` — aggregated genres/directors/decades/countries, fed to the
  recommender branches as taste context.

(The sibling `missing-movies` workflow has its OWN, separate Plex snapshot job — `plex-movie-snapshot`
— rather than sharing this one's output; see that workflow's `CLAUDE.md`.)

## Stage 2 — 8 recommender branches (subjective)

Each branch (`rec-random-1/2/3`, `rec-auteur`, `rec-canon`, `rec-thin-genre`, `rec-older-era`,
`rec-world-cinema` — specs in `src/workflows/movies/stages/branches.ts`) is its own job/child
process, one Claude CLI call, proposing raw suggestions from a lens:
- 3× `rec-random-*` — stratified-random serendipity.
- `rec-auteur` — auteur-completion (directors the owner already likes, films of theirs not owned).
- `rec-canon` — top-genre canon (well-regarded films in the owner's most-watched genres).
- `rec-thin-genre` — thin-genre round-out (genres underrepresented in the owned library).
- `rec-older-era` — older-era classics.
- `rec-world-cinema` — international/non-English cinema.

Each branch is shown a stratified sample of the owned library (`MOVIES_RECS_SAMPLE`, default 50)
plus the taste profile, and asked for `MOVIES_RECS_PER_BRANCH_ASK` (default 9) titles — headroom
above the eventual target, since verification/dedup/quality-filtering will drop some. Raw
per-branch output goes to `data/out/recs/<branch-id>.json`. Model: `MOVIES_RECS_MODEL` (default a
Sonnet 5 id), via the shared `src/services/claude.ts` `runClaude` helper (→ `callService('claude-cli', ...)`).

## Stage 3 — `rec-merge`

Pools every branch's raw suggestions (`src/workflows/movies/stages/merge.ts`), then per suggestion:
1. **TMDB title search** (`callService('tmdb', ...)`) — no match = "hallucinated," dropped.
2. **Owned check** — already in the library, dropped.
3. **Already-recommended/ignored check** (`isWorkItemDone(RECS_JOB, recKey(tmdbId), 1)`) — dropped,
   never re-surfaced.
4. **Quality bar** — TMDB `vote_average ≥ MOVIES_RECS_MIN_RATING` (default 7.0) AND
   `vote_count ≥ MOVIES_RECS_MIN_VOTES` (default 50) — below either, dropped.
5. Survivors are deduped by title+year across branches (a title suggested by multiple branches
   merges its `lens` tags rather than counting twice) and balanced by genre
   (`MOVIES_RECS_GENRE_CAP` per genre, default 3).

**Top-up loop** (bounded, `MOVIES_RECS_TOPUP_ROUNDS` rounds, default 3): if fewer than
`MOVIES_RECS_TARGET` (default 15) well-rated/un-owned/never-recommended/genre-balanced picks
survive, re-prompts all 8 branches in-memory for additional suggestions (excluding everything
already collected/owned/considered this run, up to `MOVIES_RECS_TOPUP_CONCURRENCY` branches at once,
default 4), re-verifies, re-merges, repeats until the target is reached or rounds are exhausted.
Resilient by design: per-item search failures are skipped individually and a TMDB quota hit stops
verification gracefully — the stage always writes a (possibly short) list and succeeds, so
`movie-recs-notify` always runs. Writes `data/out/recommendations.json`; appends to
`data/out/recs-history.json` (fed back into future branch prompts as "already suggested," bounded by
`MOVIES_RECS_HISTORY_CONTEXT`, default 200 titles, and `MOVIES_RECS_RECENT_WINDOW`, default 40).

## Stage 4 — `movie-recs-notify`

Reads `recommendations.json`, filters out anything owner-ignored (the `RECS_JOB` ledger), and sends
one monthly push of newly-verified picks not yet notified (`work_items` ledger, keyed
`recKey(tmdbId)`). The first run digests the whole current backlog; later runs only cover what's
new since the last one. Writes `data/out/reports/recommendations.md`.

## Ignore-to-suppress (owner UI)

- `POST /api/movie-recs/:tmdbId/ignore` / `/unignore`, backed by `ignoreSurfacedItem`/
  `unignoreSurfacedItem` against the `RECS_JOB` ledger — an ignored rec is excluded from BOTH the
  merge stage (never re-suggested) and future digests.
- Un-ignoring **deletes** the ledger row (not a status reset) — the item is treated as genuinely new
  again and can resurface in a future digest.
- Surfaced on the `movie-recommendations` workflow's dashboard detail page (Recommendations
  management section) — MANUAL-ONLY, nothing auto-ignores.
- The franchise-gaps ignore-to-suppress mechanism (`POST /api/movie-gaps/:tmdbId/ignore`, bulk
  ignore, `MovieGapsManager`) is unchanged by T468 and still rendered on THIS page even though the
  underlying `franchise-gaps`/`movie-gaps-notify` jobs now belong to the sibling `missing-movies`
  workflow — moving the dashboard section there needs `dashboard/` in scope, which was out of scope
  for the T468 backend split. See `missing-movies`'s `CLAUDE.md` for the detail.

## Files, credentials, config

- `config.ts` (`moviesConfig`) — all `data/out/` paths, the 10+ `MOVIES_RECS_*` tuning env vars,
  `PLEX_MOVIE_SECTION`. Also re-exports `gapsOut` (pointing at `missing-movies`'s
  `data/out/franchise-gaps.json`) — a compatibility alias so `src/api/server.ts`'s existing
  `GET /api/movie-gaps` endpoint keeps reading the real current file location without that file
  needing a code change as part of the T468 split (see the comment on `gapsOut` in `config.ts`).
- `contracts.ts` — gate contracts for every DAG edge in THIS workflow (snapshot→each branch, each
  branch→merge, merge→notify). The franchise-gap contracts moved to `missing-movies/contracts.ts`.
- `recs.ts` — shared pure helpers (`RECS_JOB`, `recKey`, `balanceByGenre`, `dedupeRawByTitleYear`,
  `genreNameFromIds`, `mergeLens`) — used by both `merge.ts` and (mirrored) `tv-recs`.
- `movies.ts` — pure snapshot/collection-gap logic (`buildMovieSnapshots`, `buildOwnedSet`,
  `buildTasteProfile`, `collectionGaps`, `collectionOwnedExample`). Still lives here (not moved to
  `missing-movies`) since `buildMovieSnapshots`/`buildOwnedSet`/`buildTasteProfile` are shared by
  THIS workflow's own `movie-snapshot`/`rec-merge`; `missing-movies` imports the
  franchise-gap-specific helpers (`collectionGaps`, `collectionOwnedExample`) from here rather than
  duplicating them — mirroring this file's own existing precedent of importing `extractTmdbId`
  from `../missing-tv-seasons/plex.js`.
- `stages/notify.ts` also re-exports the legacy `NOTIFY_JOB`/`gapKey` constants (UNUSED by this
  file's own recs-only logic) purely so `src/api/server.ts`'s existing import of them from this
  path keeps resolving — see the comment at the top of that file. The real gaps-notify job (and the
  source-of-truth copy of those constants) now lives in `missing-movies/stages/notify.ts`.
- Plex/TMDB connectivity: the shared `src/core/plex-client.ts` (`plexGet`/`tmdbGet`) — NOT owned by
  this workflow, shared with `missing-tv-seasons`, `missing-movies`, `tv-recommendations`,
  `plex-space-saver`.
- Credentials: `PLEX_HOST`, `PLEX_API_TOKEN`, `TMDB_API_TOKEN` (read by the shared client),
  `PLEX_MOVIE_SECTION` (this workflow's own).
