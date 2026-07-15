# CLAUDE.md — src/workflows/missing-movies/

The folder is `missing-movies`; the workflow's registered name is also **`missing-movies`**.

## What it does

Weekly, deterministic audit of the owner's Plex movie library for **franchise gaps** — films you
own some-but-not-all of in a collection, via the TMDB Collections API. No quality filter — every
factual gap is surfaced; the TMDB rating rides along for context only.

Split out of `movie-recommendations` (T468) so this deterministic audit runs on its own cadence,
independent of that workflow's subjective monthly recommendation fan-out — mirroring how
`missing-tv-seasons` and `tv-recommendations` are two independent workflows for TV.

## DAG

```
plex-movie-snapshot → franchise-gaps → movie-gaps-notify
```

Scheduled weekly (`'0 9 * * 1'`, Monday 09:00) — matching `missing-tv-seasons`'s cadence exactly (a
deliberate cadence increase from the old combined workflow's monthly schedule, for more frequent gap
alerts).

**Not limitable** — no member declares `inputKeys()`. Inputs are discovered live from Plex each run,
not a static file. `plex-movie-snapshot` and `franchise-gaps` RE-COMPUTE FRESH every run (no
skip-if-done); only `movie-gaps-notify` uses the `work_items` ledger, and there it's a "have I
already notified this?" / "has the owner ignored it?" log, not a work-done ledger — so a backlog
item is announced exactly once and an ignored item is suppressed forever.

## Stage 1 — `plex-movie-snapshot`

Reads Plex library section `PLEX_MOVIE_SECTION` (default `4`, the owner's "Movies") via the shared
`plexGet` (`src/core/plex-client.ts`), matching each movie's `tmdb://` GUID (never guessed — a
movie with no `tmdb://` GUID is flagged and excluded from franchise-gap checking, listed in the
run's logs). The Plex read is metered via the shared `plex` service (`callService('plex', ...)`),
coordinating rate limits and quotas across all Plex-touching workflows (T577). Writes
`data/out/snapshot.json` — every movie + its owned-set membership.

**This is a DEDICATED snapshot, not shared with `movie-recommendations`'s `movie-snapshot`.** It is
deliberately duplicated (not imported/reused) so the two workflows run on fully independent
schedules with no cross-workflow dependency — mirrors `plex-tv-snapshot` vs the TV recs workflow's
own snapshot. Unlike `movie-snapshot`, it does NOT build a taste profile — nothing downstream here
consumes one (only the recommender branches in `movie-recommendations` do).

## Stage 2 — `franchise-gaps` (deterministic)

Two-pass TMDB Collections audit (`src/workflows/missing-movies/stages/franchise-gaps.ts`):
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

The job name is `franchise-gaps` — **unchanged** from before the T468 split, and its pure detection
logic (`buildOwnedSet`, `collectionGaps`, `collectionOwnedExample`) is imported from the shared
`../movies/movies.js` module (owned by `movie-recommendations`, not duplicated here) since both
workflows' collection-gap math is identical.

## Stage 3 — `movie-gaps-notify`

Reads `franchise-gaps.json`, filters out anything owner-ignored (`ignoredItemKeys(NOTIFY_JOB)`), and
sends a digest of gaps not yet notified (`work_items` ledger, keyed `gapKey(tmdbId)`). The first run
digests the whole current backlog; later runs only cover what's new since the last one. Also
(re)writes a markdown report grouped by collection.

The job name (`movie-gaps-notify`) and the `NOTIFY_JOB`/`gapKey` ledger constants are **UNCHANGED**
from before the T468 split — this workflow is now their source of truth (`src/workflows/movies/stages/notify.ts`
re-exports them as a compat shim, since `src/api/server.ts`'s `/api/movie-gaps/*` endpoints import
from that path — see "Cross-workflow compat shim" below). No `work_items` migration was needed or
performed: the ledger is keyed by `(job_name, item_key)`, not workflow membership.

## Ignore-to-suppress (owner UI)

- `POST /api/movie-gaps/:tmdbId/ignore` / `/unignore`, plus a bulk
  `POST /api/movie-gaps/ignore-bulk { tmdbIds }` for "ignore all" at a collection group header.
  Backed by `ignoreSurfacedItem(MOVIE_GAPS_JOB, gapKey(tmdbId))` — upserts the ledger row to
  `ignored` even if none exists yet (a surfaced gap is typically `success` after its one
  notification, or has no row at all).
- Un-ignoring **deletes** the ledger row (not a status reset) — the item is treated as genuinely new
  again and can resurface in a future digest.
- Surfaced on the dashboard: **currently still on the `movie-recommendations` workflow detail
  page's Gaps management section** (T469, dependsOn T468, moves this to `missing-movies`'s own
  detail page — deferred, not yet done as of this workflow's creation).
- **Important semantic**: bulk "ignore all" on a collection group only ignores the EXACT gap keys
  surfaced right now — a new film added to that collection later (a sequel announced, a new TMDB
  entry) is NOT auto-ignored; it surfaces fresh.

## Cross-workflow compat shim (T468)

`src/api/server.ts` (out of this task's scope; T469 is queued to relocate its dashboard-facing
concerns) imports `NOTIFY_JOB as MOVIE_GAPS_JOB, gapKey` from `'../workflows/movies/stages/notify.js'`
and `moviesConfig.gapsOut` from `'../workflows/movies/config.js'`. Rather than touch `server.ts`:
- `src/workflows/movies/stages/notify.ts` (the now recs-only notify stage) re-exports
  `NOTIFY_JOB`/`gapKey` from this workflow's `stages/notify.js` — the source of truth moved here,
  but the import path `server.ts` already uses keeps resolving unchanged.
- `src/workflows/movies/config.ts`'s `gapsOut` is aliased to this workflow's
  `missingMoviesConfig.gapsOut` — same reasoning.

Neither shim changes behavior; they exist purely so `server.ts` doesn't need editing to keep
working. If `server.ts` is ever relocated to import from `missing-movies` directly, both shims can
be deleted.

## Files, credentials, config

- `config.ts` (`missingMoviesConfig`) — `data/out/` paths, `PLEX_MOVIE_SECTION`. No new env vars —
  reuses the same Plex/TMDB credentials as every other Plex-touching workflow.
- `contracts.ts` — gate contracts for every DAG edge (`missingMoviesSnapshotContract` for
  snapshot→franchise-gaps, `franchiseGapsContract` for franchise-gaps→notify).
- `lib.ts` — `ensureDirs`/`readJsonFile`/`writeJsonFile` (this workflow's own `data/out/` tree).
- Pure collection-gap detection logic lives in the shared `../movies/movies.js` (owned by
  `movie-recommendations`) — imported here, not duplicated.
- Plex/TMDB connectivity: the shared `src/core/plex-client.ts` (`plexGet`/`tmdbGet`, plus
  `fetchSectionMetadata`/`extractTmdbId`/`PlexAllResponse<T>` — the section-listing wrapper, GUID
  extraction, and `MediaContainer` response type this workflow's `plex-movie-snapshot` uses, T586)
  — NOT owned by this workflow, shared with `missing-tv-seasons`, `tv-recommendations`,
  `movie-recommendations`, `plex-space-saver`, `plex-language-fix`, `plex-profiles` — this is the
  7th Plex-touching workflow using it.
- Credentials: `PLEX_HOST`, `PLEX_API_TOKEN`, `TMDB_API_TOKEN` (read by the shared client),
  `PLEX_MOVIE_SECTION` (shared with `movie-recommendations`).
