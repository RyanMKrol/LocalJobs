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
declares no `inputKeys()` (not limitable; scheduled-only, always unlimited). Stages 1–2 deliberately
RE-COMPUTE FRESH every run (no skip-if-done). Idempotency lives ONLY in stage 3: its `work_items`
ledger is a "have I already notified this?" log, not a work-done log — keyed
`pairKey(tmdbId, season) = "<tmdbId>::S<season>"` under job name `plex-seasons-notify`. A row not yet
`success` is newly-detected; only actionable (still-missing) pairs get ledger rows at all, so an
"up to date" show never appears in the ledger. The first-ever run announces the whole current backlog
in one digest.

The owner can permanently silence a factual-but-unwanted gap via `ignoreSurfacedItem` (the same
ignore-to-suppress mechanism `movie-recommendations`'s franchise-gaps/recs use) —
`POST /api/missing-seasons/:tmdbId/:season/ignore` (plus bulk and unignore counterparts), surfaced on
this workflow's dashboard detail page.

## Shared Plex/TMDB connectivity

Plex + TMDB HTTP access (`plexGet`/`tmdbGet`/`resolvePlexHost`) lives in the top-level
`src/core/plex-client.ts` — shared by all FOUR Plex-touching workflows (this one,
`tv-recommendations`, `movie-recommendations`, `plex-space-saver`), not owned by this workflow.
Notably it self-heals a changed DHCP IP: the owner's Plex server's IP changes on lease renewal, so a
hardcoded `PLEX_HOST` used to break `plex-tv-snapshot`. `resolvePlexHost()` (cached once per daemon
run) confirms the configured `PLEX_HOST` is a live Plex (and, if `PLEX_MACHINE_ID` is set, the RIGHT
one) via `GET /identity`, and otherwise scans the local IPv4 /24 subnet(s) on `:32400` (bounded by
per-probe timeout, concurrency, and an overall wall-clock cap) until it finds one — logging the
discovered host so it can be pinned in `.env` next time. Throws a clear "set PLEX_HOST" error if
nothing answers.

## Files

- `config.ts` — data paths (`snapshotOut`/`missingOut`/`reportDir`) plus `PLEX_TV_SECTION`
  (default `5`).
- `stages/snapshot.ts`, `stages/season-check.ts`, `stages/notify.ts` — the 3 DAG stages.
- `lib.ts`, `plex.ts`, `tmdb.ts` — pure helpers (GUID extraction, season-completeness math, formatting).
- `data/out/` — `snapshot.json`, `missing-seasons.json`, `reports/missing-seasons.md`.

Credentials (read by the shared client, not this workflow's own config): `PLEX_HOST`,
`PLEX_API_TOKEN`, optional `PLEX_MACHINE_ID`, and `TMDB_API_TOKEN` (or the legacy `TVDB_API_TOKEN`
fallback).
