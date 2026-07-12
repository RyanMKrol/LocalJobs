# CLAUDE.md — src/workflows/missing-movies/

The folder is `missing-movies`; the workflow's registered name is also **`missing-movies`**.

**T468 split note:** this workflow is the deterministic franchise-gap audit that used to live inside
`movie-recommendations`, sharing one combined monthly digest with that workflow's taste-based
recommendation layer. It was split out into its own workflow/folder (design record:
`.harness/worklog/T467.md`), mirroring how `missing-tv-seasons` is split from `tv-recommendations`
for TV. `movie-recommendations` is now recommendations-only — see
`src/workflows/movies/CLAUDE.md`.

## What it does

Weekly audit of the owner's Plex movie library for FRANCHISE GAPS — films you own some-but-not-all
of in a collection, via the TMDB Collections API. No quality filter: every factual gap is
surfaced. Pushes ONE weekly digest of the newly-detected gaps; the owner can ignore-to-suppress a
gap from the dashboard.

## DAG

```
plex-movie-snapshot → franchise-gaps → movie-gaps-notify
```

Scheduled WEEKLY (`'0 9 * * 1'`, Mondays 09:00) — a DELIBERATE cadence change from the monthly
cadence this audit ran at while it shared `movie-recommendations`'s digest, matching
`missing-tv-seasons`'s cadence instead. Serial (`maxConcurrency` unset = default 1) — each stage
strictly feeds the next.

**Not limitable** — no member declares `inputKeys()`. Inputs are discovered live from Plex each
run, not a static file. `plex-movie-snapshot` + `franchise-gaps` RE-COMPUTE FRESH every run (no
skip-if-done); only `movie-gaps-notify` uses the `work_items` ledger, and there it's a "have I
already notified this gap?" / "has the owner ignored it?" log, not a work-done ledger — so a
backlog gap is announced exactly once and an ignored gap is suppressed forever.

## Stage 1 — `plex-movie-snapshot`

Reads Plex library section `PLEX_MOVIE_SECTION` (default `4`, the owner's "Movies") via the shared
`plexGet` (`src/core/plex-client.ts`), matching each movie's `tmdb://` GUID (never guessed — a
movie with no `tmdb://` GUID is flagged and excluded from franchise-gap checking, listed in the
run's logs). Writes `data/out/snapshot.json` — every movie + its owned-set membership.

This is a DELIBERATE duplicate of `movie-recommendations`'s own `movie-snapshot` job (own job, own
`data/out/`, T467 design decision) rather than a shared stage — mirroring `missing-tv-seasons`'s
`plex-tv-snapshot` vs `tv-recommendations`'s `tv-snapshot`. It deliberately SKIPS building a taste
profile (`taste-profile.json`), since `franchise-gaps` never reads one — only
`movie-recommendations`'s recommender branches do, and building it here would be dead work.

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

The pure detection helpers (`buildOwnedSet`/`collectionGaps`/`collectionOwnedExample`) are
**imported from `../movies/movies.js`**, not duplicated — mirroring that file's own existing
precedent of importing `extractTmdbId` from `../missing-tv-seasons/plex.js`. This job's own
`name` (`'franchise-gaps'`) is UNCHANGED from before the T468 split.

## Stage 3 — `movie-gaps-notify`

Reads `franchise-gaps.json`, filters out anything owner-ignored (`ignoredItemKeys(NOTIFY_JOB)`),
and sends **one** weekly push of just the newly-detected gaps (`work_items` ledger, keyed
`gapKey(tmdbId)`). The first run digests the whole current backlog; later runs only cover what's
new since the last one. Also (re)writes `data/out/reports/franchise-gaps.md`, grouped by
collection with a "you own: X" anchor per collection.

This job's `name` (`'movie-gaps-notify'`) and the `NOTIFY_JOB` ledger key value are UNCHANGED from
before the T468 split — every existing ignored/notified row keeps resolving with **zero data
migration**. `src/api/server.ts`'s dashboard endpoints still import `NOTIFY_JOB`/`gapKey` from
`../workflows/movies/stages/notify.js` (a small compatibility re-export left there, unused by that
file's own now-recs-only logic, purely because `src/api/server.ts` was out of scope for the T468
build task) — this file's own copies of those two constants (identical values) are the source of
truth going forward. A future task with `src/api/server.ts` in scope should point that import here
directly and delete the compat re-export.

## Ignore-to-suppress (owner UI)

- `POST /api/movie-gaps/:tmdbId/ignore` / `/unignore`, plus a bulk
  `POST /api/movie-gaps/ignore-bulk { tmdbIds }` for "ignore all" at a collection group header.
  Backed by `ignoreSurfacedItem(MOVIE_GAPS_JOB, gapKey(tmdbId))` — upserts the ledger row to
  `ignored` even if none exists yet (a surfaced gap is typically `success` after its one
  notification, or has no row at all).
- Un-ignoring **deletes** the ledger row (not a status reset) — the item is treated as genuinely new
  again and can resurface in a future digest.
- As of T468, still surfaced on the **`movie-recommendations`** workflow's dashboard detail page
  (`MovieGapsManager`) rather than this workflow's own page — the backend job (`franchise-gaps`/
  `movie-gaps-notify`) moved here, but moving the dashboard UI section needs `dashboard/` in scope,
  which was out of scope for the T468 backend split. Tracked as a follow-up; the API endpoints
  themselves are unaffected either way. MANUAL-ONLY, nothing auto-ignores.
- **Important semantic**: bulk "ignore all" on a collection group only ignores the EXACT gap keys
  surfaced right now — a new film added to that collection later (a sequel announced, a new TMDB
  entry) is NOT auto-ignored; it surfaces fresh.

## Files, credentials, config

- `config.ts` (`missingMoviesConfig`) — `data/out/` paths (`snapshotOut`, `gapsOut`, `reportDir`),
  `PLEX_MOVIE_SECTION` (same section as `movie-recommendations` — same Plex movies library, just a
  separate snapshot/processing pipeline).
- `contracts.ts` — gate contracts for every DAG edge in this workflow (`missingMoviesSnapshotContract`
  for the snapshot→franchise-gaps boundary, `franchiseGapsContract` for franchise-gaps→notify). Its
  own copy, not shared with `movies/contracts.ts` — this workflow has its own artifacts on disk.
- `lib.ts` — `ensureDirs`/`writeJsonFile`, scoped to this workflow's own `data/out/` tree.
- Plex/TMDB connectivity: the shared `src/core/plex-client.ts` (`plexGet`/`tmdbGet`) — NOT owned by
  this workflow, shared with `missing-tv-seasons`, `movie-recommendations`, `tv-recommendations`,
  `plex-space-saver`.
- Credentials: `PLEX_HOST`, `PLEX_API_TOKEN`, `TMDB_API_TOKEN` (read by the shared client),
  `PLEX_MOVIE_SECTION` (shared with `movie-recommendations`).
