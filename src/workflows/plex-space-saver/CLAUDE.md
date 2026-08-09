# CLAUDE.md — src/workflows/plex-space-saver/

A single-stage, report-only audit of where Plex library disk space is going — distinct from
`missing-tv-seasons`, which audits missing seasons, not disk usage.

Reuses the shared Plex client (`src/core/plex-client.ts`'s `resolvePlexHost`/`plexGet` — DHCP
self-heal, plus `fetchSectionMetadata`/`PlexAllResponse<T>` — the shared section-listing wrapper +
`MediaContainer` response type this stage's movie/show/episode listing fetches use, T586) and the
existing Plex env (`PLEX_HOST`/`PLEX_API_TOKEN`/optional `PLEX_MACHINE_ID`), plus
the SAME `PLEX_MOVIE_SECTION`/`PLEX_TV_SECTION` env vars the `movies`/`missing-tv-seasons` workflows
already read (no new env vars). Plex reads are metered via the shared `plex` service (`callService('plex', ...)`),
enforcing rate-limit + quota consistency across all Plex-touching workflows.

Size is obtained via the API — each Plex `Media.Part` carries a `size` in bytes — never a filesystem
walk.

**Granularity: one row per title.** Each movie stands alone (its own media parts summed); each TV
show is a single row summing every episode across every season (grouped by `grandparentRatingKey`).
`plex-space-saver-scan` (the only stage — no DAG edge, no gate needed) fetches the movie section, the
TV section's shows, and its flat episode list (`type=4`), computes a biggest-first breakdown via
`buildMovieRows`/`buildShowRows`/`buildBreakdown` in `lib.ts`, and writes it to
`data/out/size-breakdown.json`.

**Report only — never flags or suggests deletions.** Re-scans fresh every run (an audit, not a
build); idempotent per ISO calendar week via the `work_items` ledger (`weekKey`) — a manual re-run the
same week regenerates that week's breakdown rather than duplicating it. Runs weekly (Sundays 06:00).

**Surfaced via the declared-output-form mechanism, not markdown prose** — the ledger row's
`detail.format: 'size-table'` + `detail.path` point the unified Output section's fetch endpoint at the
structured JSON breakdown, served through `safeOutputFile`; the dashboard's generic
`WorkflowOutputSection` renders it via its raw-content fallback with no dedicated viewer needed.
(`detail.markdown` is also set, to the same path, purely so the output list query's "View" button
still surfaces — the fetch endpoint itself dispatches on `detail.format`/`detail.path` regardless.)

**The old shrink guard (T519) was removed.** The "library shrank" safeguard now lives in the
`plex-library-guard` workflow (daily, per-file inventory, zero-threshold by default), which
supersedes the weekly total-size check this workflow used to carry. Nothing here reads or writes
`data/out/size-baseline.json` anymore: an existing copy on disk is orphaned and safe to delete
manually.

**Plex reads are response-cached for a 3-hour window (T477) — a deliberate change from the prior
design.** All three `plexGet` calls (movies/shows/episodes section listings) now pass a `cacheKey`
derived from the request path (`plex:<path>`) to `callService('plex', ..., { cacheKey })`, engaging
the `plex` service's 3-hour cache TTL (T476), so a back-to-back Plex-touching workflow run (e.g. the
admin "Run all workflows" button) reuses the response instead of re-hitting Plex. This workflow only
runs weekly on its own schedule, far outside the TTL window. The one accepted trade-off: a MANUAL
re-run within 3 hours of a prior run (this workflow's own, or another Plex-touching workflow's
overlapping section read) will see the cached total rather than a fresh live read until the cache
expires. `runScan` accepts an injectable `plexFetch` option (tests) that stands in for the real
`plexGet`, still routed through `callService`, so the cache dedup itself is unit-tested without a
live Plex call.
