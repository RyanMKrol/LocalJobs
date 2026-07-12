# CLAUDE.md — src/workflows/missing-movies/

The folder and the workflow's registered name are both **`missing-movies`**.

Split out of `movie-recommendations` (T468) so the DETERMINISTIC franchise-gap audit runs and
notifies independently of the SUBJECTIVE recommendation layer — mirroring the existing
`tv-recommendations` / `missing-tv-seasons` split. The `franchise-gaps` job name and the
`movie-gaps-notify` job name/ledger key are UNCHANGED from before the split, so no `work_items`
migration was needed or performed.

## What it does

Weekly audit of the owner's Plex movie library for franchise gaps — films you own some-but-not-all
of in a collection, via the TMDB Collections API. No quality filter: every factual gap is surfaced.
Pushes ONE weekly digest of newly-detected gaps, grouped by collection in the accompanying report.
The owner can ignore-to-suppress a gap from the dashboard.

## DAG

```
plex-movie-snapshot ──movie-snapshot──▶ franchise-gaps ──franchise-gaps──▶ movie-gaps-notify
```

Serial (`maxConcurrency: 1`) — each stage strictly feeds the next. Scheduled weekly (`'0 9 * * 1'`,
Mondays 09:00) — **a deliberate cadence change** from the old monthly cadence when this lived inside
`movie-recommendations`, matching `missing-tv-seasons`'s cadence exactly for more frequent gap
alerts.

**Not limitable** — no member declares `inputKeys()`. Inputs are discovered live from Plex each run,
not a static file. `plex-movie-snapshot` and `franchise-gaps` RE-COMPUTE FRESH every run (no
skip-if-done); only `movie-gaps-notify` uses the `work_items` ledger, and there it's a "have I
already notified this gap?" / "has the owner ignored it?" log, not a work-done ledger — so a
backlog gap is announced exactly once and an ignored gap is suppressed forever.

## Stage 1 — `plex-movie-snapshot`

This workflow's OWN Plex movie snapshot — separate from `movie-recommendations`'s `movie-snapshot`
(mirrors `plex-tv-snapshot` vs the TV recommender's own snapshot; same underlying Plex library
section, two independent jobs/files so each workflow's DAG is self-contained). Reads Plex library
section `PLEX_MOVIE_SECTION` (default `4`, shared with `movie-recommendations` — deliberately not a
separate env var) via the shared `plexGet` (`src/core/plex-client.ts`), matching each movie's
`tmdb://` GUID (never guessed — a movie with no `tmdb://` GUID is flagged and excluded, listed in
the run's logs). Writes ONLY `data/out/snapshot.json` — no `taste-profile.json`, since
`franchise-gaps` (the only consumer here) never reads one.

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

The pure detection math (`collectionGaps`, `collectionOwnedExample`, `buildOwnedSet`) is NOT
duplicated here — it's imported from `movie-recommendations`'s `movies.ts`, the same
cross-workflow pure-helper-reuse convention that file itself uses for `extractTmdbId` from
`missing-tv-seasons/plex.ts`. Types (`MovieSnapshotFile`, `FranchiseGap`, `FranchiseGapsFile`,
`TmdbCollectionDetail`, `TmdbMovieDetail`) are likewise shared from `movie-recommendations`'s
`types.ts` rather than redeclared.

## Stage 3 — `movie-gaps-notify`

Reads `franchise-gaps.json`, filters out anything owner-ignored (`ignoredItemKeys(NOTIFY_JOB)`), and
sends a weekly push covering only gaps not yet notified (`work_items` ledger, keyed
`gapKey(tmdbId)`). Writes `data/out/reports/franchise-gaps.md`, grouped by collection with a TMDB
link + rating + an owned-example anchor per collection. The first run digests the whole current
backlog; later runs only cover what's new since the last one.

## Ignore-to-suppress (owner UI)

- `POST /api/movie-gaps/:tmdbId/ignore` / `/unignore`, plus a bulk
  `POST /api/movie-gaps/ignore-bulk { tmdbIds }` for "ignore all" at a collection group header
  (and the `unignore-bulk` counterpart). Backed by `ignoreSurfacedItem(MOVIE_GAPS_JOB,
  gapKey(tmdbId))` — upserts the ledger row to `ignored` even if none exists yet (a surfaced gap is
  typically `success` after its one notification, or has no row at all).
- Un-ignoring **deletes** the ledger row (not a status reset) — the item is treated as genuinely new
  again and can resurface in a future digest.
- MANUAL-ONLY, nothing auto-ignores. **Transitional note (T468/T469):** `src/api/server.ts` and the
  dashboard are out of THIS task's scope, so `moviesConfig.gapsOut` is aliased to this workflow's
  real `franchise-gaps.json` (see `movie-recommendations/CLAUDE.md`'s compat-shim note) and the
  franchise-gaps management UI still renders on the `movie-recommendations` workflow detail page for
  now, not yet on this workflow's own page — the queued T469 follow-up relocates both the
  `server.ts` imports and the dashboard section here.
- **Important semantic**: bulk "ignore all" on a collection group only ignores the EXACT gap keys
  surfaced right now — a new film added to that collection later (a sequel announced, a new TMDB
  entry) is NOT auto-ignored; it surfaces fresh.
- The equivalent recommendation ignore-to-suppress (`/api/movie-recs/*`) stays on the
  `movie-recommendations` workflow's own detail page — see that workflow's `CLAUDE.md`.

## Files, credentials, config

- `config.ts` (`missingMoviesConfig`) — this workflow's own `data/out/` paths (`snapshotOut`,
  `gapsOut`, `reportDir`), `PLEX_MOVIE_SECTION` (shared with `movie-recommendations`).
- `contracts.ts` — gate contracts for both DAG edges (`missingMoviesSnapshotContract`,
  `franchiseGapsContract`) — this workflow's own, separate from `movie-recommendations`'s
  `contracts.ts` (they used to be the same file, pre-split).
- `lib.ts` — `ensureDirs`/`writeJsonFile` for this workflow's own `data/out/` tree.
- Plex/TMDB connectivity: the shared `src/core/plex-client.ts` (`plexGet`/`tmdbGet`) — NOT owned by
  this workflow, shared with `missing-tv-seasons`, `tv-recommendations`, `movie-recommendations`,
  `plex-space-saver`.
- Credentials: `PLEX_HOST`, `PLEX_API_TOKEN`, `TMDB_API_TOKEN` (read by the shared client),
  `PLEX_MOVIE_SECTION` (this workflow's own, shared with `movie-recommendations`).
