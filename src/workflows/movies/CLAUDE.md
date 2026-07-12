# CLAUDE.md — src/workflows/movies/

The folder is `movies`; the workflow's registered name is **`movie-recommendations`** — distinct
names, same thing. Referenced elsewhere as either.

## What it does

Monthly, taste-based Plex movie **recommendation** layer: 8 parallel Claude recommender branches
propose picks from a stratified sample of the owner's library, merged with code-side TMDB
verification, cross-branch dedup, and per-genre balancing, then pushed as one monthly digest.

**The deterministic franchise-gap audit (films you own some-but-not-all of in a collection) moved
to the separate `missing-movies` workflow (T468)** — see `src/workflows/missing-movies/CLAUDE.md`.
Splitting it out mirrors how `missing-tv-seasons` and `tv-recommendations` are two independent
workflows for TV: this workflow no longer has a `franchise-gaps` stage, and its own `movie-snapshot`
is NOT shared with `missing-movies` (that workflow has its own dedicated snapshot).

The owner can ignore-to-suppress a recommendation from the dashboard.

## DAG

```
movie-snapshot ──┬─→ rec-random-1 ─┐
                  ├─→ rec-random-2 ─┤
                  ├─→ rec-random-3 ─┤
                  ├─→ rec-auteur ───┼─→ rec-merge ─→ movie-recs-notify
                  ├─→ rec-canon ────┤
                  ├─→ rec-thin-genre┤
                  ├─→ rec-older-era┤
                  └─→ rec-world-cinema┘
```

`maxConcurrency: 4` — all 8 recommender branches depend ONLY on `movie-snapshot`, so once it
finishes they run up to 4 at a time instead of sequentially (each branch is its own child process
invoking the Claude CLI; the cap protects the Mac Mini while collapsing wall-time). Every branch
routes its Claude calls through the shared `claude-cli` service (`callService`), so the rate limit +
monthly quota are enforced GLOBALLY regardless of concurrency — the service is the spend governor,
not the cap. Scheduled monthly (`'0 9 1 * *'`, 1st at 09:00).

**Not limitable** — no member declares `inputKeys()`. Inputs are discovered live from Plex each run,
not a static file. `movie-snapshot` RE-COMPUTES FRESH every run (no skip-if-done); only
`movie-recs-notify` uses the `work_items` ledger, and there it's a "have I already recommended
this?" / "has the owner ignored it?" log, not a work-done ledger — so a backlog item is announced
exactly once and an ignored item is suppressed forever.

## Stage 1 — `movie-snapshot`

Reads Plex library section `PLEX_MOVIE_SECTION` (default `4`, the owner's "Movies") via the shared
`plexGet` (`src/core/plex-client.ts`), matching each movie's `tmdb://` GUID (never guessed — a
movie with no `tmdb://` GUID is flagged and excluded from downstream matching, listed in the run's
logs). Writes:
- `data/out/snapshot.json` — every movie + its owned-set membership.
- `data/out/taste-profile.json` — aggregated genres/directors/decades/countries, fed to the
  recommender branches as taste context.

**Not shared with `missing-movies`.** That workflow's franchise-gap audit uses its OWN dedicated
snapshot (`plex-movie-snapshot`, its own `data/out/snapshot.json`) — deliberately duplicated, not
imported, so the two workflows have zero cross-workflow dependency and run on independent
schedules. This stage is the ONLY one that still builds `taste-profile.json` (the gap audit never
needed it — see `missing-movies`'s own `CLAUDE.md`).

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

Reads `recommendations.json`, filters out anything owner-ignored (`ignoredItemKeys(RECS_JOB)`), and
sends a monthly push covering only items not yet notified (`work_items` ledger, keyed
`recKey(tmdbId)`). The first run digests the whole current pool; later runs only cover what's new
since the last one. Also (re)writes a monthly `recommendations.md` report.

## Ignore-to-suppress (owner UI)

- `POST /api/movie-recs/:tmdbId/ignore` / `/unignore`, backed by
  `ignoreSurfacedItem(RECS_JOB, recKey(tmdbId))` — an ignored rec is excluded from BOTH the merge
  stage (never re-suggested) and future digests.
- Un-ignoring **deletes** the ledger row (not a status reset) — the item is treated as genuinely new
  again and can resurface in a future digest.
- Surfaced on the `movie-recommendations` workflow's dashboard detail page (Recommendations
  management section) — MANUAL-ONLY, nothing auto-ignores.
- (Franchise-gap ignore-to-suppress — `/api/movie-gaps/*` — moved with the audit to
  `missing-movies`; see that workflow's own `CLAUDE.md`.)

## Files, credentials, config

- `config.ts` (`moviesConfig`) — `data/out/` paths, the 10+ `MOVIES_RECS_*` tuning env vars,
  `PLEX_MOVIE_SECTION`. `gapsOut` is a **compat-shim alias** into `missing-movies`'s own config —
  see "Cross-workflow compat shim" below.
- `contracts.ts` — gate contracts for every remaining DAG edge (snapshot→each branch, each
  branch→merge, merge→notify). The franchise-gaps contract moved to `missing-movies/contracts.ts`.
- `recs.ts` — shared pure helpers (`RECS_JOB`, `recKey`, `balanceByGenre`, `dedupeRawByTitleYear`,
  `genreNameFromIds`, `mergeLens`) — used by both `merge.ts` and (mirrored) `tv-recs`.
- `movies.ts` — pure snapshot/collection-gap logic (`buildMovieSnapshots`, `buildOwnedSet`,
  `buildTasteProfile`, `collectionGaps`, `collectionOwnedExample`). **Still owned by this folder**
  even though `missing-movies`'s `franchise-gaps` stage imports `collectionGaps`/
  `collectionOwnedExample`/`buildMovieSnapshots`/`buildOwnedSet` from here — the pure collection-gap
  math is identical for both workflows, so it isn't duplicated.
- Plex/TMDB connectivity: the shared `src/core/plex-client.ts` (`plexGet`/`tmdbGet`) — NOT owned by
  this workflow, shared with `missing-tv-seasons`, `tv-recommendations`, `missing-movies`,
  `plex-space-saver`, `plex-language-fix`, `plex-profiles`.
- Credentials: `PLEX_HOST`, `PLEX_API_TOKEN`, `TMDB_API_TOKEN` (read by the shared client),
  `PLEX_MOVIE_SECTION` (shared with `missing-movies`).

## Cross-workflow compat shim (T468)

`src/api/server.ts` (out of T468's scope; T469 is queued to relocate its dashboard-facing concerns)
imports `NOTIFY_JOB as MOVIE_GAPS_JOB, gapKey` from `'../workflows/movies/stages/notify.js'` and
`moviesConfig.gapsOut` from `'../workflows/movies/config.js'` — paths that predate the split. Rather
than touch `server.ts`:
- `src/workflows/movies/stages/notify.ts` (this recs-only notify stage) re-exports
  `NOTIFY_JOB`/`gapKey` from `missing-movies`'s `stages/notify.js` — the source of truth moved
  there, but the import path `server.ts` already uses keeps resolving unchanged.
- `moviesConfig.gapsOut` is aliased to `missingMoviesConfig.gapsOut` — same reasoning.

Neither shim changes behavior; they exist purely so `server.ts` doesn't need editing to keep
working. See `missing-movies/CLAUDE.md` for the workflow that now owns these for real.
