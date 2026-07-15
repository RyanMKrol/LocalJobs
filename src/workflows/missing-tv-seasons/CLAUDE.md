# CLAUDE.md — src/workflows/missing-tv-seasons/

Audits the owner's Plex TV library for newly-released COMPLETE seasons they don't already own —
snapshot → check → notify, scheduled weekly.

## What it does

3-stage DAG, serial (`maxConcurrency: 1`), scheduled Mondays 09:00 (`0 9 * * 1`):

1. **`plex-tv-snapshot`** reads Plex library section `PLEX_TV_SECTION` (default `5`, "TV shows") by
   GUID, building a per-show snapshot: title, `tmdbId` (parsed from the show's `tmdb://` GUID — never
   guessed; a show with no such GUID is flagged unverifiable) and the highest owned REGULAR season
   (season 0/specials excluded). Writes `data/out/snapshot.json`.
2. **`tmdb-season-check`** reads the snapshot and, for each show with a `tmdbId`, checks TMDB
   (`GET /tv/{id}` for status + seasons, `GET /tv/{id}/season/{N}` per candidate season) for the
   highest AIRED regular season and which owned+1..aired seasons are fully COMPLETE (every episode
   aired). ENDED/CANCELED shows are NOT skipped — revivals happen. TMDB calls route through the
   shared, rate-limited `tmdb` service. Writes `data/out/missing-seasons.json`.
3. **`plex-seasons-notify`** sends ONE digest push naming every newly-detected `(show, season)` pair,
   then marks each notified so it's never re-announced, and writes a markdown report to
   `data/out/reports/missing-seasons.md`.

## Idempotency — "re-scan + notification-log", not "work-done"

This workflow has NO static input list — its inputs are DISCOVERED live from Plex every run, so it
declares no `inputKeys()` (not limitable; scheduled-only, always unlimited).

**Stages 1–2: Per-show ledger for visibility + failure gating (NOT for skip-if-done).** Both
stages now record `work_items` rows for dashboard Inputs & Outputs visibility and (for stage 2) to
drive the failed-count-blocks-the-run guard:

- **Stage 1 (`plex-tv-snapshot`)** records one row per show with key `<tmdbId ?? ratingKey>` (the
  TMDB id as string when present, else the Plex ratingKey). All rows are `status='success'` (a show
  is successfully snapshotted whether it has a TMDB GUID or not). `detail` captures the show's name,
  TMDB id (or null), and highest owned season.
- **Stage 2 (`tmdb-season-check`)** records one row per show, also keyed by `<tmdbId ?? ratingKey>`,
  with `rootKey` explicitly set to chain back to stage 1's row. Outcomes:
  - **Checked successfully, actionable** (`status='success'`): `detail` includes the TMDB status,
    highest aired season, and the list of complete missing seasons.
  - **Checked successfully, nothing missing** (`status='success'`): `detail` includes the TMDB status,
    highest aired season, and an empty `completeMissingSeasons` list.
  - **No tmdb:// GUID** (`status='failed'`): `detail` states `reason: 'no tmdb:// GUID'`. This
    deliberately blocks the run via the failed-count guard, so a show with no GUID will block every
    subsequent scheduled run until a human **Unstick**s or **Ignore**s it on the dashboard. Note:
    neither control currently provides a permanent fix for a show that will never get a GUID —
    Unstick just deletes the row so it fails fresh next run; Ignore marks it ignored but stage 2
    does NOT currently consult the ledger before recomputing failed status, so it would be
    recounted as failed again. This is an **accepted rough edge** per the owner's guidance
    ("I don't care about the gap ... I'll deal with the problem if it pops up") and is deliberately
    out of scope for this task.
  - **Genuine TMDB call error** (`status='failed'`): `detail` includes the error message.

Stages 1–2 deliberately RE-COMPUTE FRESH every run (no skip-if-done — the ledger rows are upserted,
not gated by `isWorkItemDone` checks). Idempotency in the traditional skip-if-done sense lives ONLY
in stage 3: its `work_items` ledger is a "have I already notified this?" log, not a work-done log —
keyed `pairKey(tmdbId, season) = "<tmdbId>::S<season>"` under job name `plex-seasons-notify`. A
row not yet `success` is newly-detected; only actionable (still-missing) pairs get ledger rows at
all, so an "up to date" show never appears in the ledger. The first-ever run announces the whole
current backlog in one digest.

Stage 3's `markWorkItem` call also carries `rootKey: String(tmdbId)` (the same key stages 1–2 use
for that show), so the dashboard's per-run Inputs & Outputs panel can chain a notified `(show,
season)` pair all the way back through stage 2's per-show row to stage 1's — completing the lineage
across all three stages.

The owner can permanently silence a factual-but-unwanted gap via `ignoreSurfacedItem` (the same
ignore-to-suppress mechanism `movie-recommendations`'s franchise-gaps/recs use) —
`POST /api/missing-seasons/:tmdbId/:season/ignore` (plus bulk and unignore counterparts), surfaced on
this workflow's dashboard detail page.

## Shared Plex/TMDB connectivity

Plex + TMDB HTTP access (`plexGet`/`tmdbGet`/`resolvePlexHost`, plus `fetchSectionMetadata`/
`extractTmdbId`/`PlexAllResponse<T>` — the shared section-listing wrapper, GUID extraction, and
`MediaContainer` response type this workflow's `plex-tv-snapshot` stage uses, T586) lives in the
top-level `src/core/plex-client.ts` — shared by all FOUR Plex-touching workflows (this one,
`tv-recommendations`, `movie-recommendations`, `plex-space-saver`), not owned by this workflow.
`plex.ts`'s own `extractTmdbId` is a thin re-export of the core implementation, not a separate one.
Notably it self-heals a changed DHCP IP: the owner's Plex server's IP changes on lease renewal, so a
hardcoded `PLEX_HOST` used to break `plex-tv-snapshot`. `resolvePlexHost()` (cached once per daemon
run) confirms the configured `PLEX_HOST` is a live Plex (and, if `PLEX_MACHINE_ID` is set, the RIGHT
one) via `GET /identity`, and otherwise scans the local IPv4 /24 subnet(s) on `:32400` (bounded by
per-probe timeout, concurrency, and an overall wall-clock cap) until it finds one — logging the
discovered host so it can be pinned in `.env` next time. Throws a clear "set PLEX_HOST" error if
nothing answers.

**Plex reads are metered via the shared `plex` service.** Stage 1 (`plex-tv-snapshot`) wraps both
`plexGet` calls (the shows listing and the flat episode listing) in `callService('plex', ...)` to
coordinate rate limits and quotas across all Plex-touching workflows via the shared service meter.

**Plex reads are response-cached for a 3-hour window (T477).** Both calls pass a `cacheKey` derived
from the request path (`plex:<path>`, e.g. `plex:/library/sections/5/all?includeGuids=1`) to
`callService('plex', ..., { cacheKey })`, engaging the `plex` service's 3-hour cache TTL (T476). A
second read of the SAME section within that window (e.g. another Plex-touching workflow triggered
back-to-back via the admin "Run all workflows" button) is served from the cache instead of hitting
Plex again. `runSnapshot` accepts an injectable `fetchPlex` option (tests) that stands in for the
real `plexGet`, still routed through `callService`, so the cache dedup itself is unit-tested without
a live Plex call.

## Files

- `config.ts` — data paths (`snapshotOut`/`missingOut`/`reportDir`) plus `PLEX_TV_SECTION`
  (default `5`).
- `stages/snapshot.ts`, `stages/season-check.ts`, `stages/notify.ts` — the 3 DAG stages.
- `lib.ts`, `plex.ts`, `tmdb.ts` — pure helpers (GUID extraction, season-completeness math, formatting).
- `data/out/` — `snapshot.json`, `missing-seasons.json`, `reports/missing-seasons.md`.

Credentials (read by the shared client, not this workflow's own config): `PLEX_HOST`,
`PLEX_API_TOKEN`, optional `PLEX_MACHINE_ID`, and `TMDB_API_TOKEN` (or the legacy `TVDB_API_TOKEN`
fallback).
