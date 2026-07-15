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

**Shrink guard (T519) — a safety net against silent library data loss.** After computing this run's
total on-disk size, the scan diffs it against the PRIOR run's persisted baseline
(`data/out/size-baseline.json`, `{ totalBytes, at }`, written/read via `lib.ts`'s
`readBaseline`/`writeBaseline`) and fires exactly ONE critical push (`core/notifier`'s `push`, urgent
priority + `rotating_light,warning` tags) if the library shrank by more than `PLEX_SIZE_DROP_GB`
(env-overridable, default **1 GB**). This is deliberately an **absolute GB threshold, not a
percentage** — the library should essentially never shrink, so even a small absolute drop beyond a
buffer absorbing trivial metadata/transcode fluctuation is worth flagging. The drop math itself is the
pure, unit-tested `checkDrop` in `lib.ts`.

- **First run (no baseline yet):** seeds the baseline, sends no alert.
- **Stable or growing library** (`current >= prior`, or a drop under the threshold): sends nothing.
- **Drop exceeds the threshold:** sends the alert once, guarded against re-sending for the SAME
  already-alerted baseline via the notify-once `work_items` ledger (job name
  `plex-space-saver-shrink-alert`, keyed by the baseline's `at` timestamp — mirrors
  `missing-tv-seasons/stages/notify.ts`'s "have I already notified this?" pattern). A later run that
  diffs against a NEW (post-alert) baseline can alert again if it also drops.
- The baseline is written at the END of every successful scan, alert or not, so the NEXT run always
  has a fresh prior total to diff against. The size breakdown report itself is unaffected — the drop
  check is additive, never a replacement.

**Plex reads are response-cached for a 3-hour window (T477) — a deliberate change from the prior
design.** All three `plexGet` calls (movies/shows/episodes section listings) now pass a `cacheKey`
derived from the request path (`plex:<path>`) to `callService('plex', ..., { cacheKey })`, engaging
the `plex` service's 3-hour cache TTL (T476), so a back-to-back Plex-touching workflow run (e.g. the
admin "Run all workflows" button) reuses the response instead of re-hitting Plex. This workflow only
runs weekly on its own schedule, far outside the TTL window, so the shrink guard's week-over-week
comparison is unaffected in normal operation. The one accepted trade-off: a MANUAL re-run within 3
hours of a prior run (this workflow's own, or another Plex-touching workflow's overlapping section
read) will see the cached total rather than a fresh live read until the cache expires. `runScan`
accepts an injectable `plexFetch` option (tests) that stands in for the real `plexGet`, still routed
through `callService`, so the cache dedup itself is unit-tested without a live Plex call.
