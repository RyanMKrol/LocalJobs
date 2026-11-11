# CLAUDE.md — src/workflows/plex-space-saver/

A single-stage, report-only audit of where Plex library disk space is going — distinct from
`missing-tv-seasons`, which audits missing seasons, not disk usage.

Reads Plex through the shared client (`src/core/plex-client.ts`): the stage calls
`fetchSectionMetadata`, the shared section-listing wrapper, which resolves the Plex host (with the
DHCP self-heal) and routes every read through the shared `plex` service (`callService('plex', ...)`),
so rate limits and quotas are counted together with every other Plex-touching workflow. It uses the
existing Plex env (`PLEX_HOST`/`PLEX_API_TOKEN`/optional `PLEX_MACHINE_ID`) and the SAME
`PLEX_MOVIE_SECTION`/`PLEX_TV_SECTION` env vars the `movies`/`missing-tv-seasons` workflows already
read (no new env vars).

Size is obtained via the API — each Plex `Media.Part` carries a `size` in bytes — never a filesystem
walk.

**Granularity: one row per title.** Each movie stands alone (its own media parts summed); each TV
show is a single row summing every episode across every season (grouped by `grandparentRatingKey`).
`plex-space-saver-scan` (the only stage) fetches the movie section, the TV section's shows, and its
flat episode list (`type=4`), computes a biggest-first breakdown via
`buildMovieRows`/`buildShowRows`/`buildBreakdown` in `lib.ts`, and writes it to
`data/out/size-breakdown.json`.

**Report only: never flags or suggests deletions.** Re-scans fresh every run (an audit, not a
build). Runs weekly (Sundays 06:00). The stage has a 5 minute timeout and 3 retries. It declares no
`inputKeys()`, so the workflow is not limitable.

## How the stages hand data to each other (ports)

A ports workflow (see "Ports" in the root `CLAUDE.md`; the artifact type is in `contracts.ts`):

| Stage | Inputs | Outputs |
|---|---|---|
| `plex-space-saver-scan` | none | `breakdown` (`plex-size-breakdown`, `data/out/size-breakdown.json`) |

The file is rewritten on every run, and a run that returned without writing it fails. The
artifact's check also fails an empty library (no titles at all), so a run whose Plex read came
back empty fails and its breakdown is not committed. The stage writes the file before that check
runs, though, so the empty file is left on disk until the next good run replaces it. Its
declared `format` is `size-table`, so the
dashboard's Output section and the run page both open it in the size-table viewer
(`SizeTableOutputBody`). The stage writes no ledger rows.

**The old shrink guard (T519) was removed.** The "library shrank" safeguard now lives in the
`plex-library-guard` workflow (daily, per-file inventory, zero-threshold by default), which
supersedes the weekly total-size check this workflow used to carry. Nothing here reads or writes
`data/out/size-baseline.json` anymore: an existing copy on disk is orphaned and safe to delete
manually.

**Plex reads are response-cached for a 3-hour window (T477).** All three `fetchSectionMetadata`
calls (the movie, show and episode listings) go through `callService('plex', ..., { cacheKey })`
with the default cache key `plex:<path>`, which engages the `plex` service's 3-hour cache TTL
(T476). A back-to-back Plex-touching workflow run (e.g. the admin "Run all workflows" button)
reuses the response instead of re-hitting Plex. This workflow only runs weekly on its own schedule,
far outside the TTL window. The one accepted trade-off: a MANUAL re-run within 3 hours of a prior
run (this workflow's own, or another Plex-touching workflow's overlapping section read) sees the
cached total, not a fresh live read, until the cache expires. `runScan` accepts an injectable
`plexFetch` option (tests) that stands in for the real `plexGet`, still routed through
`callService`, so the cache dedup itself is unit-tested without a live Plex call.
