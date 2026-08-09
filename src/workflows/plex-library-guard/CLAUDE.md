# CLAUDE.md — src/workflows/plex-library-guard/

A daily safeguard against silent Plex library data loss, built as a safety net while
file-moving workflows are developed. It snapshots every media file in the library and sends
one urgent push if the total size decreases or any previously-seen file disappears. It
supersedes plex-space-saver's old weekly shrink guard (T519), which was removed when this
workflow landed; this guard is the single owner of the "library shrank" signal.

## What it does

Single stage (`plex-library-guard-scan`, no DAG edge so no gate contracts), scheduled daily
at 10:30 (`30 10 * * *`, staggered clear of the other Plex workflows). Each run:

1. Fetches the movie section listing and the TV section's flat episode listing (`?type=4`)
   via `fetchSectionMetadata`. Just 2 Plex API calls: the section listings carry
   `Media[].Part[]` inline with `size` and `file`.
2. Builds a full per-file inventory: one `SnapshotFileEntry` per media Part (a 2-part movie
   is 2 entries), keyed `<ratingKey>::<part.id>` (falling back to the part's file path, then
   its index). Movies are titled "Heat (1995)", episodes "The Wire — S01E03 — The Buys".
3. Diffs against the previous run's persisted snapshot (`data/out/library-snapshot.json`):
   a total-size drop beyond `PLEX_GUARD_DROP_GB` (default 0, any decrease) and/or any
   missing file triggers ONE combined urgent push (`rotating_light,warning` tags) naming up
   to 20 missing titles. The full list always lands in `data/out/guard-report.json` (written
   every run) and the run log.
4. Overwrites the baseline snapshot and records TWO ledger rows: one per calendar day
   (`dayKey`, `detail.format: 'json'` + `detail.path` pointing at the report, plus
   `detail.markdown` set to the same path purely so the Output list's View button
   surfaces), and one STABLE row keyed `snapshot` (updated in place each run) whose
   `detail.format: 'library-snapshot'` points at the full baseline inventory. The
   dashboard renders that form as a searchable per-file list
   (`LibrarySnapshotOutputBody` in `dashboard/app/components/OutputRenderer.tsx`:
   summary header, title/path filter, at most 300 rows painted at once). Because the
   inventory is ~10 MB, the `library-snapshot` format is exempted from the output
   endpoints' 512 KB payload cap (`outputPayloadMax(format)` in `src/api/server.ts`).
   The snapshot row is recorded only right after a successful baseline write, so the
   dashboard always shows exactly the inventory the next run will diff against.

## The write-ordering invariant (protect this)

**The baseline snapshot is only ever overwritten AFTER the alert path settles.** A failed
push throws before the snapshot write, so the run fails with the old baseline intact and the
retry re-diffs and re-attempts. This ordering IS the feature: reordering the writes could
silently swallow a deletion. `stages/scan.test.ts` asserts it directly (push failure leaves
the baseline untouched).

Because the baseline only advances on success, each disappearance is naturally alerted
exactly once. The already-alerted ledger (job `plex-library-guard-alert`, keyed by the
previous snapshot's `generatedAt`) exists only for the crash-between-push-and-write / retry
path, mirroring missing-tv-seasons' notify-once pattern; it is checked before pushing and
marked only after a successful push. A file that reappears is counted as an addition
(logged, never pushed).

## Bad-read guards

- **Empty read**: 0 movies or 0 episodes throws before any write (a populated library never
  legitimately reads empty; the missing-tv-seasons precedent). The last-good snapshot and
  report are preserved.
- **Suspected partial read**: more than half the previous inventory missing at once
  (`SUSPECT_MISSING_RATIO = 0.5`, only when the previous inventory had at least
  `SUSPECT_MIN_PREV_FILES = 10` files; code constants in `lib.ts`, deliberately not env).
  The run still alerts loudly (a real mass deletion is exactly the disaster case, never go
  silent) but does NOT overwrite the baseline and throws. A transient Plex misread
  self-heals next run against the intact baseline (the alert ledger prevents a repeat push);
  a real mass deletion keeps failing loudly until the owner intervenes.

## Reads are LIVE, never cached

Both `fetchSectionMetadata` calls pass `cacheKey: null`, explicitly opting out of the `plex`
service's 3-hour response cache (T477). A guard must never diff a stale cached listing: a
cached-vs-live mix could fabricate or mask a disappearance. Keep it this way. The calls are
still metered through `callService('plex', ...)` like every other Plex read.

## Config and env

`config.ts` (routes through `resolveWorkflowDataDir`, mandatory for test isolation) reuses
the shared Plex env: `PLEX_HOST`/`PLEX_API_TOKEN` (read by the shared client),
`PLEX_MOVIE_SECTION` (default 4) and `PLEX_TV_SECTION` (default via missing-tv-seasons'
`plexConfig`). The only guard-specific var is `PLEX_GUARD_DROP_GB` (default 0). `lib.ts`
deliberately keeps a local copy of `formatBytes` rather than importing from
plex-space-saver: a safety workflow must not break if the workflow it superseded is later
restructured.

## Files

- `config.ts` — paths (`snapshotOut`, `reportOut`) + sections + threshold.
- `types.ts` — `SnapshotFileEntry`, `LibrarySnapshotFile`, `GuardReportFile`, Plex listing shapes.
- `lib.ts` — pure helpers: `partKey`, `buildSnapshot`, `diffSnapshots`, `isSuspectRead`,
  `buildAlertPush`, `buildReport`, `readSnapshot`.
- `stages/scan.ts` / `scan.job.ts` — the single stage.
- `plex-library-guard.test.ts` (pure logic) + `stages/scan.test.ts` (behaviour, including
  the ordering invariant and the cache opt-out).
- `data/out/library-snapshot.json` (the baseline) + `data/out/guard-report.json` (per-run
  summary, the Output section artifact).
