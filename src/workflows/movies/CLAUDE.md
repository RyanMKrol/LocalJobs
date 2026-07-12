# CLAUDE.md — src/workflows/movies/

The folder is `movies`; the workflow's registered name is **`movie-recommendations`** — distinct
names, same thing. Referenced elsewhere as either.

## What it does

Monthly audit of the owner's Plex movie library that surfaces two independent kinds of finding in
ONE combined digest:

1. **Franchise gaps** (deterministic) — films you own some-but-not-all of in a collection, via the
   TMDB Collections API. No quality filter — every factual gap is surfaced.
2. **Recommendations** (subjective) — 8 parallel Claude recommender branches propose taste-based
   picks from a stratified library sample, merged with code-side TMDB verification, cross-branch
   dedup, and per-genre balancing.

Both halves dedupe per TMDB id so nothing repeats across runs; the owner can ignore-to-suppress
either a gap or a recommendation from the dashboard.

## DAG

```
movie-snapshot ──┬─→ franchise-gaps ─────────────────────┐
                  ├─→ rec-random-1 ─┐                     │
                  ├─→ rec-random-2 ─┤                     │
                  ├─→ rec-random-3 ─┤                      │
                  ├─→ rec-auteur ───┼─→ rec-merge ─────────┼─→ movie-gaps-notify
                  ├─→ rec-canon ────┤                     │
                  ├─→ rec-thin-genre┤                     │
                  ├─→ rec-older-era┤                      │
                  └─→ rec-world-cinema┘                    │
```

`maxConcurrency: 4` — `franchise-gaps` and all 8 recommender branches depend ONLY on
`movie-snapshot`, so once it finishes they run up to 4 at a time instead of sequentially (each
branch is its own child process invoking the Claude CLI; the cap protects the Mac Mini while
collapsing wall-time). Every branch routes its Claude calls through the shared `claude-cli` service
(`callService`), so the rate limit + monthly quota are enforced GLOBALLY regardless of concurrency —
the service is the spend governor, not the cap. Scheduled monthly (`'0 9 1 * *'`, 1st at 09:00).

**Not limitable** — no member declares `inputKeys()`. Inputs are discovered live from Plex each run,
not a static file. `movie-snapshot` and `franchise-gaps` RE-COMPUTE FRESH every run (no
skip-if-done); only `movie-gaps-notify` uses the `work_items` ledger, and there it's a "have I
already notified this?" / "has the owner ignored it?" log, not a work-done ledger — so a backlog
item is announced exactly once and an ignored item is suppressed forever.

## Stage 1 — `movie-snapshot`

Reads Plex library section `PLEX_MOVIE_SECTION` (default `4`, the owner's "Movies") via the shared
`plexGet` (`src/core/plex-client.ts`), matching each movie's `tmdb://` GUID (never guessed — a
movie with no `tmdb://` GUID is flagged and excluded from franchise-gap checking, listed in the
run's logs). Writes:
- `data/out/snapshot.json` — every movie + its owned-set membership.
- `data/out/taste-profile.json` — aggregated genres/directors/decades/countries, fed to the
  recommender branches as taste context.

## Stage 2 — `franchise-gaps` (deterministic)

Two-pass TMDB Collections audit (`src/workflows/movies/stages/franchise-gaps.ts`):
1. For each owned movie with a tmdbId: `GET /movie/{id}` → its `belongs_to_collection`. Collects
   every DISTINCT collection id the library touches (deduped — a collection with several owned
   members is only resolved once).
2. For each distinct collection: `GET /collection/{id}` → `parts[]`. A gap is any RELEASED part
   whose tmdb id is NOT owned.

No quality filter, no skip heuristics — every factual gap surfaces; the TMDB rating rides along for
context only. Both TMDB calls route through `callService('tmdb', ...)`; a hit quota stops the pass
gracefully (logs a warn, writes whatever was found so far) rather than failing the run. Writes
`data/out/franchise-gaps.json` (sorted by collection → year → title for a stable, readable
artifact), including a `collectionExamples` map (one owned title per collection, for the digest to
show "you own: X" context).

## Stage 3 — 8 recommender branches (subjective)

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

## Stage 4 — `rec-merge`

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
`movie-gaps-notify` always runs. Writes `data/out/recommendations.json`; appends to
`data/out/recs-history.json` (fed back into future branch prompts as "already suggested," bounded by
`MOVIES_RECS_HISTORY_CONTEXT`, default 200 titles, and `MOVIES_RECS_RECENT_WINDOW`, default 40).

## Stage 5 — `movie-gaps-notify`

Reads both `franchise-gaps.json` and `recommendations.json`, filters out anything owner-ignored
(`ignoredItemKeys(NOTIFY_JOB)` for gaps, the `RECS_JOB` ledger for recs), and sends **one** combined
monthly push with separate Gaps + Recommendations sections — only for items not yet notified
(`work_items` ledger, keyed `gapKey(tmdbId)`/`recKey(tmdbId)`). The first run digests the whole
current backlog; later runs only cover what's new since the last one.

## Ignore-to-suppress (owner UI, both halves)

- **Franchise gaps**: `POST /api/movie-gaps/:tmdbId/ignore` / `/unignore`, plus a bulk
  `POST /api/movie-gaps/ignore-bulk { tmdbIds }` for "ignore all" at a collection group header.
  Backed by `ignoreSurfacedItem(MOVIE_GAPS_JOB, gapKey(tmdbId))` — upserts the ledger row to
  `ignored` even if none exists yet (a surfaced gap is typically `success` after its one
  notification, or has no row at all).
- **Recommendations**: `POST /api/movie-recs/:tmdbId/ignore` / `/unignore`, same
  `ignoreSurfacedItem`/`RECS_JOB` mechanism — an ignored rec is excluded from BOTH the merge stage
  (never re-suggested) and future digests.
- Un-ignoring **deletes** the ledger row (not a status reset) — the item is treated as genuinely new
  again and can resurface in a future digest.
- Both are surfaced on the `movie-recommendations` workflow's dashboard detail page (Recommendations
  & Gaps management sections) — MANUAL-ONLY, nothing auto-ignores.
- **Important semantic**: bulk "ignore all" on a collection group only ignores the EXACT gap keys
  surfaced right now — a new film added to that collection later (a sequel announced, a new TMDB
  entry) is NOT auto-ignored; it surfaces fresh.

## Files, credentials, config

- `config.ts` (`moviesConfig`) — all `data/out/` paths, the 10+ `MOVIES_RECS_*` tuning env vars,
  `PLEX_MOVIE_SECTION`.
- `contracts.ts` — gate contracts for every DAG edge (snapshot→franchise-gaps, snapshot→each
  branch, each branch→merge, franchise-gaps+merge→notify).
- `recs.ts` — shared pure helpers (`RECS_JOB`, `recKey`, `balanceByGenre`, `dedupeRawByTitleYear`,
  `genreNameFromIds`, `mergeLens`) — used by both `merge.ts` and (mirrored) `tv-recs`.
- `movies.ts` — pure snapshot/collection-gap logic (`buildMovieSnapshots`, `buildOwnedSet`,
  `buildTasteProfile`, `collectionGaps`, `collectionOwnedExample`).
- Plex/TMDB connectivity: the shared `src/core/plex-client.ts` (`plexGet`/`tmdbGet`) — NOT owned by
  this workflow, shared with `missing-tv-seasons`, `tv-recommendations`, `plex-space-saver`.
- Credentials: `PLEX_HOST`, `PLEX_API_TOKEN`, `TMDB_API_TOKEN` (read by the shared client),
  `PLEX_MOVIE_SECTION` (this workflow's own).
