# CLAUDE.md — src/workflows/missing-tv-seasons/

Audits the owner's Plex TV library for complete seasons that have aired and that they do not own.
Three stages: snapshot, check, notify. The folder and the workflow are both named
`missing-tv-seasons`. The manifest file is `plex.workflow.ts`.

## What it does

A 3-stage DAG, serial (`maxConcurrency: 1`), scheduled Mondays 09:00 (`0 9 * * 1`):

```
plex-tv-snapshot → tmdb-season-check → plex-seasons-notify
```

1. **`plex-tv-snapshot`** reads Plex library section `PLEX_TV_SECTION` (default `5`) and builds one
   entry per show: title, `tmdbId` (from the show's `tmdb://` GUID, never guessed) and the highest
   owned regular season (season 0, specials, is excluded). It makes two Plex reads, the show
   listing and a flat episode listing. Writes `data/out/snapshot.json`. `timeoutMs` 5 minutes,
   `maxRetries: 3`.

   **It fails on a 0-show read.** If the section listing returns no shows the stage throws before
   writing anything. A populated library never really reads empty, so an empty result is a Plex
   problem (a stale DHCP host, a dropped request, a bad cached response). Writing it would let
   `tmdb-season-check` read 0 shows and replace the last good `missing-seasons.json` with an
   empty one. Throwing keeps the last good files, stops the later stages, and shows the failure.
2. **`tmdb-season-check`** reads the snapshot and, for each show with a `tmdbId`, asks TMDB
   (`GET /tv/{id}` for status and seasons, `GET /tv/{id}/season/{N}` per candidate season) for
   the highest aired regular season and which seasons from owned+1 up to it are complete (every
   episode aired). Ended and cancelled shows are still checked, because revivals happen. TMDB
   calls go through the shared `tmdb` service with a cache key per path. Writes
   `data/out/missing-seasons.json`: `shows[]` (those with a complete missing season),
   `unverifiable[]` (no GUID) and `errors[]` (TMDB call failed). `timeoutMs` 30 minutes,
   `maxRetries: 3`.
3. **`plex-seasons-notify`** sends one digest push naming every newly found `(show, season)`
   pair, then marks each one so it is never announced again. It rewrites the markdown report
   `data/out/reports/missing-seasons.md` on every run. `timeoutMs` 2 minutes, `maxRetries: 3`.

## How the stages hand data to each other (ports)

A ports workflow (see "Ports" in the root `CLAUDE.md`; artifact types in `contracts.ts`):

| Stage | Inputs | Outputs |
|---|---|---|
| `plex-tv-snapshot` | none | `snapshot` (`plex-tv-snapshot`, `snapshot.json`) |
| `tmdb-season-check` | `snapshot` | `missing` (`tmdb-missing-seasons`, `missing-seasons.json`) |
| `plex-seasons-notify` | `missing` | `report` (`missing-seasons-report`, `reports/missing-seasons.md`), `digest` (`missing-seasons-digest`, inline counts) |

All files are under `data/out/`. Each output is rebuilt on every run.

## Idempotency: re-scan, then remember what was announced

There is no static input list. The inputs are read live from Plex on every run, so no stage
declares `inputKeys()` and the workflow is not limitable.

Stages 1 and 2 recompute everything on every run and write no ledger rows. The run page lists
the shows from the artifacts themselves.

**A show that cannot be checked fails the run, after the output is committed.** Stage 2 fails
when any show has no `tmdb://` GUID or its TMDB call errored. It writes `missing-seasons.json`
first, including `unverifiable[]` and `errors[]`, and the stage commits that output before
rethrowing (`missing.commit()` in `season-check.job.ts`). So the failed run's page lists the
shows that were the problem, shown as failed items on the artifact. Because the stage failed,
`plex-seasons-notify` does not run. A show with no GUID therefore fails every run until it gets
one in Plex. There is no ledger row for such a show, so the dashboard's Unstick and Ignore
controls do not apply to it. The owner accepted this rough edge ("I'll deal with the problem if
it pops up").

A TMDB quota stop is different: the loop ends early with a warning and the stage writes what it
has. If nothing else failed, the run succeeds with a list that only covers the shows checked
before the stop.

The only ledger is stage 3's. It is a "have I already announced this?" log, not a work-done log,
under job name `plex-seasons-notify` (`NOTIFY_JOB` in `stages/notify.ts`), keyed
`pairKey(tmdbId, season) = "<tmdbId>::S<season>"`. A pair with no done row is new. Rows are
written only for pairs that were announced, so an up-to-date show never appears in the ledger.
Pairs are marked only after the push succeeds, so a failed push is retried. The first run
announces the whole backlog in one digest. These rows are what the notify stage lists as its
items on a run page.

The owner can dismiss a gap they do not want with `ignoreSurfacedItem`, the same mechanism the
`missing-movies` gaps and the two recommenders use:
`POST /api/missing-seasons/:tmdbId/:season/ignore` and `/unignore`, plus
`/api/missing-seasons/ignore-bulk` and `/unignore-bulk`, on this workflow's dashboard page. A
dismissed pair counts as done, so it is never announced, and the report leaves it out.

## Shared Plex/TMDB connectivity

Plex and TMDB access (`plexGet`, `tmdbGet`, `resolvePlexHost`, `fetchSectionMetadata`,
`extractTmdbId`) is in the top-level `src/core/plex-client.ts`. It is not owned by this workflow.
Nine workflows use it: `missing-tv-seasons`, `tv-recommendations`, `movie-recommendations`,
`missing-movies`, `plex-space-saver`, `plex-library-guard`, `plex-language-fix`, `plex-profiles`
and `plex-rename`. `plex.ts`'s `extractTmdbId` is a re-export of the core one.

The client copes with a changed DHCP address. The Plex server's IP changes on lease renewal, so
a fixed `PLEX_HOST` used to break `plex-tv-snapshot`. `resolvePlexHost()` checks that the
configured `PLEX_HOST` is a live Plex (and, if `PLEX_MACHINE_ID` is set, the right one) with
`GET /identity`. If not, it scans the local IPv4 /24 subnets on port 32400, bounded by a
per-probe timeout, a concurrency limit and an overall time cap, and logs the host it finds so it
can be set in `.env`. When the configured host simply did not answer, it also keeps waiting on
it during the scan (up to `PLEX_WAKE_TIMEOUT_MS`, default 30s), because a server whose disks
have spun down can be slow to wake. If nothing answers it throws a "set PLEX_HOST" error. The
resolved host is cached for the life of the process.

**Plex reads go through the shared `plex` service and are response-cached.** Both of stage 1's
reads use `fetchSectionMetadata`, which calls `callService('plex', ..., { cacheKey })` with a key
of `plex:<path>` (for example `plex:/library/sections/5/all?includeGuids=1`). A second read of
the same path within the service's 3-hour cache window (for example another Plex workflow run
just before) is served from the cache. `runSnapshot` takes a `fetchPlex` option for tests that
replaces the low-level GET and still goes through `callService`, so the caching path can be
tested without a live Plex.

## Files

- `plex.workflow.ts`: the manifest.
- `contracts.ts`: the artifact types the stages exchange (`plexTvSnapshot`, `missingSeasons`,
  `seasonsReport`, `seasonsDigest`), each with its check and how it is shown.
- `config.ts` (`plexConfig`): the data paths (`snapshotOut`, `missingOut`, `reportDir`) and
  `PLEX_TV_SECTION` (default `5`).
- `stages/snapshot.ts`, `stages/season-check.ts`, `stages/notify.ts`, each with its `.job.ts`:
  the 3 stages.
- `plex.ts` (building the snapshot from Plex's listings), `tmdb.ts` (season maths), `lib.ts`
  (directories, JSON helpers, season-range formatting), `types.ts`.
- `data/out/`: `snapshot.json`, `missing-seasons.json`, `reports/missing-seasons.md`.

Services called: `plex` (snapshot) and `tmdb` (season check).

Credentials (read by the shared client, not this workflow's config): `PLEX_HOST`,
`PLEX_API_TOKEN`, optional `PLEX_MACHINE_ID`, and `TMDB_API_TOKEN` (or the older
`TVDB_API_TOKEN` as a fallback).
