# CLAUDE.md — src/workflows/missing-movies/

The folder is `missing-movies`, and so is the workflow's registered name.

## What it does

A weekly audit of the owner's Plex movie library for franchise gaps: released films in a TMDB
collection the owner has some, but not all, of. There is no quality filter. Every gap is listed,
and the TMDB rating is shown for context only.

It is a separate workflow from `movie-recommendations` so that this factual audit runs weekly on
its own, apart from that workflow's monthly Claude recommender. `missing-tv-seasons` and
`tv-recommendations` are split the same way for TV.

## DAG

```
plex-movie-snapshot → franchise-gaps → movie-gaps-notify
```

Scheduled weekly (`'0 9 * * 1'`, Monday 09:00), the same time as `missing-tv-seasons`.

Not limitable: no stage declares `inputKeys()`. The library is read live from Plex on every run.

## How the stages hand data to each other (ports)

A ports workflow (see "Ports" in the root `CLAUDE.md`; artifact types in `contracts.ts`):

| Stage | Inputs | Outputs |
|---|---|---|
| `plex-movie-snapshot` | none | `snapshot` (`plex-movie-snapshot`, `snapshot.json`) |
| `franchise-gaps` | `snapshot` | `gaps` (`franchise-gaps`, `franchise-gaps.json`) |
| `movie-gaps-notify` | `gaps` | `report` (`franchise-gaps-report`, `reports/franchise-gaps.md`), `digest` (`franchise-gaps-digest`, inline counts) |

All files are under `data/out/`. Each output is rebuilt on every run, so a stage that returned
without writing its file fails instead of handing the next stage last week's.

`plex-movie-snapshot` and `franchise-gaps` recompute everything on every run and write no ledger
rows. The run page lists the snapshot's movies and the gaps from the artifacts themselves. The
only ledger is `movie-gaps-notify`'s, keyed by the missing film's TMDB id. It records "have I
already announced this gap?" and "has the owner dismissed it?", not work done, so a gap is
announced once and a dismissed gap stays out.

## Stage 1: `plex-movie-snapshot`

Reads Plex library section `PLEX_MOVIE_SECTION` (default `4`) through `fetchSectionMetadata` in
the shared `src/core/plex-client.ts`. Each movie's TMDB id comes from its `tmdb://` GUID and is
never guessed. A movie with no such GUID is logged and cannot be checked for gaps. The read goes
through the shared `plex` service (`callService('plex', ...)`) and opts out of that service's
response cache (`cacheKey: null`), so every run reads the library as it is now. Writes
`data/out/snapshot.json`: every movie with its TMDB id. `timeoutMs` 5 minutes, `maxRetries: 3`.

This snapshot is this workflow's own. `movie-recommendations` has a separate `movie-snapshot`
stage, and neither workflow reads the other's file, so they run on independent schedules. Unlike
`movie-snapshot`, this stage builds no taste profile, because nothing here reads one.

**It fails on a 0-movie read** (`missing-tv-seasons`' snapshot has the same guard). If the section
listing returns no movies the stage throws before writing anything. A populated library never
really reads empty, so an empty result is a Plex problem, and writing it would let
`franchise-gaps` find 0 gaps and replace the last good `franchise-gaps.json`. Throwing keeps the
last good files, stops the later stages, and shows the failure.

## Stage 2: `franchise-gaps`

Two passes against TMDB (`stages/franchise-gaps.ts`):

1. For each owned movie with a TMDB id: `GET /movie/{id}`, read `belongs_to_collection`, and
   collect the distinct collection ids. A collection with several owned films is fetched once.
2. For each distinct collection: `GET /collection/{id}`, read `parts[]`. A gap is any released
   part whose TMDB id is not owned.

Both calls go through `callService('tmdb', ...)` with a cache key per path. Writes
`data/out/franchise-gaps.json`, sorted by collection, year, then title, with a
`collectionExamples` map (one owned title per collection, so the report can say "You own: X").
`timeoutMs` 30 minutes, `maxRetries: 3`.

How it handles trouble:

- A collection fetch that errors is logged and the loop carries on. The file is still written,
  and then the stage throws, so the run fails and is retried.
- A `/movie/{id}` fetch that errors is logged as a warning and skipped. It does not fail the run.
- A TMDB quota stop ends the pass early with a warning, and the stage writes what it has and
  succeeds. A quota stop in pass 1 skips pass 2 entirely. Either way that run's
  `franchise-gaps.json` and report can be short until the next full run.

The gap logic (`buildOwnedSet`, `collectionGaps`, `collectionOwnedExample`) and the snapshot
builder (`buildMovieSnapshots`) are imported from `../movies/movies.js`, and the types from
`../movies/types.js`. That folder belongs to `movie-recommendations`. The code is shared rather
than copied because the maths is the same for both workflows.

## Stage 3: `movie-gaps-notify`

Reads the gaps, removes any the owner dismissed, and finds those with no done row in the ledger
(job name `movie-gaps-notify`, `NOTIFY_JOB` in `stages/notify.ts`, keyed `gapKey(tmdbId)`). It
rewrites `data/out/reports/franchise-gaps.md` (current gaps grouped by collection, new ones
flagged) on every run. If there are new gaps it sends one push, and only after the push succeeds
does it mark each gap `success`. A failed push throws before anything is marked, so the retry
sends the digest again. The first run announces the whole backlog. Later runs announce only what
is new. Its inline `digest` output records how many were announced, already announced and
dismissed. `timeoutMs` 2 minutes, `maxRetries: 3`.

The job name and ledger key are the same as before this audit was split out of
`movie-recommendations`. The ledger is keyed by job name and item key, not by workflow, so
nothing had to be migrated.

## Ignore-to-suppress (owner UI)

- `POST /api/movie-gaps/:tmdbId/ignore` and `/unignore`, plus bulk
  `POST /api/movie-gaps/ignore-bulk { tmdbIds }` and `/unignore-bulk` for a whole collection
  group. Backed by `ignoreSurfacedItem('movie-gaps-notify', gapKey(tmdbId))`, which sets the
  ledger row to `ignored` and creates it if there is none yet.
- Un-ignoring deletes the ledger row. The gap is then treated as new and can be announced again.
- The controls are on this workflow's own dashboard page (`/workflows/missing-movies`).
- A bulk ignore on a collection only ignores the gap keys shown at that moment. A film added to
  that collection later is not ignored. It shows up as a new gap.

## Cross-workflow compat shim

`src/api/server.ts` imports `NOTIFY_JOB` and `gapKey` from
`'../workflows/movies/stages/notify.js'` and reads `moviesConfig.gapsOut` from
`'../workflows/movies/config.js'`, paths from before the split. So that `server.ts` did not have
to change:

- `src/workflows/movies/stages/notify.ts` re-exports `NOTIFY_JOB` and `gapKey` from this
  workflow's `stages/notify.js`, where they are defined.
- `moviesConfig.gapsOut` is an alias of this workflow's `missingMoviesConfig.gapsOut`.

Neither changes behaviour. If `server.ts` is changed to import from `missing-movies` directly,
both can be deleted.

## Files, credentials, config

- `config.ts` (`missingMoviesConfig`): the `data/out/` paths and `PLEX_MOVIE_SECTION`. No env
  vars of its own.
- `contracts.ts`: the artifact types the stages exchange (`plexMovieSnapshot`, `franchiseGaps`,
  `gapsReport`, `gapsDigest`), each with its check and how it is shown.
- `lib.ts`: `ensureDirs`, `readJsonFile`, `writeJsonFile`.
- Plex and TMDB access is the shared `src/core/plex-client.ts` (`fetchSectionMetadata`,
  `tmdbGet`). It is not owned by this workflow. Nine workflows use it: `missing-movies`,
  `movie-recommendations`, `tv-recommendations`, `missing-tv-seasons`, `plex-space-saver`,
  `plex-library-guard`, `plex-language-fix`, `plex-profiles` and `plex-rename`.
- Services called: `plex` (snapshot) and `tmdb` (gap check).
- Credentials: `PLEX_HOST`, `PLEX_API_TOKEN`, `TMDB_API_TOKEN` (read by the shared client).
  `PLEX_MOVIE_SECTION` is shared with `movie-recommendations`.
