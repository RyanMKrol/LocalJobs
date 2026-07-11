# A01: Retention & housekeeping — nothing ever prunes runs/logs/usage/cache, the WAL is unmanaged, launchd logs grow forever, and repo clones never get cleaned

**Type**: arch/feature · **Priority**: P2 · **Effort**: M
**Area**: db / daemon / ops
**Sources**: three review agents found this independently (core, DB+API, services/ops); measured live state included below.
**Affected files**: `src/db/store.ts` (new pruning functions), `src/daemon.ts` or a new one-stage `maintenance` workflow, `src/db/schema.sql` (one new index), `scripts/install-launchd.sh` (log paths), `src/workflows/projects-sync/stages/github-sync.ts` (clone pruning)

## Problem

Nothing in the run/schedule path ever deletes anything. Measured on the live machine
(2026-07-11):

```
run_logs 5,702 · work_items 6,002 · work_item_runs 5,994 · service_usage 38,565 · job_usage 1,296
jobs.db 24.5 MB · jobs.db-wal 18.8 MB (≈75% of DB size — checkpoints not keeping up)
dashboard.err.log 1.8 MB · daemon.out.log 578 KB (launchd appends forever, no rotation)
projects-sync data/repos 43 MB (incl. the stale LocalJobs self-clone) · chrome-profile 141 MB
```

Specific consequences:

- The verbose-logging convention is right per-run but unbounded in aggregate; the only deletion
  paths (per-workflow "Clear output data", Admin bulk reset) are deliberately destructive — they
  also wipe the `work_items` idempotency ledger and output files — so "trim old history" is
  currently done *by hand via a destructive action* (the `runs` table is at 78 rows only because
  the owner recently nuked it).
- `listRecentRuns` is `ORDER BY started_at DESC LIMIT ?` with **no index on bare
  `started_at`** (only `(job_name, started_at)` + `(status)`) — a full scan + sort on every
  dashboard poll, degrading forever.
- `service_usage` is queried only over trailing 60 s/day/month windows yet keeps every row
  forever — 38.5k rows of provably dead weight (keep ~13 months for the F05 trends feature).
- Expired `service_cache` rows are never deleted (TTL enforced read-side only; only the manual
  clear-all removes rows).
- Nothing runs `PRAGMA wal_checkpoint(TRUNCATE)` or `VACUUM`, ever.
- projects-sync clones into `data/repos/<name>` and never deletes — a renamed/deleted GitHub
  repo leaves its clone forever; the documented registry-shadowing incident's artifact (the
  LocalJobs self-clone) still sits on disk as dead weight.

## Proposed design

**A daily housekeeping pass in the daemon** (not a workflow — it must also cover
deleted/renamed workflows' rows), plus one weekly heavier step. All env-tunable with generous
defaults; every deletion logged with counts.

1. `pruneRunHistory()` in `store.ts`: delete `runs` + their `run_logs` older than
   `LOCALJOBS_RETENTION_DAYS` (default 90; 0 = keep forever) while ALWAYS keeping the last K
   runs per job (default 20) so history never empties for rarely-run workflows.
   `workflow_runs`/`workflow_run_logs` on a longer default (365 d).
   **NEVER touch** `work_items` (permanent state, not history) or the parts of `service_usage`
   within the trend window.
2. `service_usage`: delete rows older than ~13 months (keeps a year of F05 trend data safely
   beyond the monthly quota window). `service_cache`: delete rows past TTL + 7 days.
3. `job_usage`: same 13-month policy.
4. Weekly: `PRAGMA wal_checkpoint(TRUNCATE)`; guarded `VACUUM` (only if free-page ratio is
   high — VACUUM blocks writers; run at a quiet hour, e.g. 04:30).
5. New index in a migration (per the T098 rule — inside the migration, not schema bootstrap
   for existing DBs; new-DB `schema.sql` can carry it since `started_at` is an original column —
   verify): `CREATE INDEX idx_runs_started ON runs(started_at DESC)`.
6. **launchd log rotation**: cheapest is `/etc/newsyslog.d/local-jobs.conf` (5 MB × 5 archives,
   one file, sudo once); no-sudo alternative: the housekeeping pass copies-tail-then-**truncates
   in place** any `data/*.log` over N MB (launchd holds the fd — must truncate, never rename).
7. **Repo-clone pruning**: after `github-sync` writes the catalog, delete any `data/repos/<name>`
   not in the current repo list (the catalog is already the authoritative set; ~5 lines). Delete
   the stale LocalJobs self-clone once by hand.
8. Surface on `/admin`: retention settings line + last-sweep timestamp + per-table deleted
   counts.

Related-but-separate: F02 (backup) should run BEFORE the weekly heavy step so a bad prune is
recoverable. Cross-ref A07 (reducing per-progress-event write amplification) — less garbage
generated is better than more garbage collected.

## Acceptance criteria

- After a sweep on a seeded scratch DB: old runs/logs gone, last-K-per-job preserved,
  `work_items` untouched, `service_usage` >13 months gone, expired cache rows gone.
- WAL file shrinks after the weekly checkpoint.
- Dashboard "Recent runs" query plan uses the new index (`EXPLAIN QUERY PLAN` shows no full
  scan).
- Docs updated: README + CLAUDE.md (retention env vars, the new admin surface) — docs-as-Done.

## Test plan

Store-level unit tests for each pruning function (seeded scratch DB, boundary ages, K-per-job
floor); migration test extension for the new index (`migrate-existing-db.test.ts` pattern).
