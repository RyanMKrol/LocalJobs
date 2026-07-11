# F02: Backup & restore story — jobs.db (every ledger, override, and spend meter) is single-copy on one machine

**Type**: feature · **Priority**: P1 · **Effort**: M
**Area**: workflows (new) / db / docs
**Backlog cross-ref**: not tracked. Evidence of need: four hand-named `data/jobs.db.bak-before-*` files from June sessions (manual, unsafe `cp` against a live WAL DB).

## Problem

`data/jobs.db` is the sole home of: every idempotency ledger — including the NOT-re-derivable
ones (plex-language-fix's "processed exactly once, ever" apply ledger; the movie-recs
never-re-recommend log; every "have I notified this?" audit ledger) — all ignore decisions,
user overrides, certified flags, spend meters, and run history. It is gitignored, on one
machine, with **no backup mechanism anywhere**. Losing it means: every audit workflow
re-announces its entire backlog, every ignore decision is forgotten, and — expensively — places
re-runs **paid** Google Places + Gemini enrichment over the whole corpus (done-ness lives in the
ledger, not the output files). `data/out/**` (hundreds of second-brain profiles) and `.env` are
equally single-copy. No migrate-to-a-new-Mini doc exists.

## Design sketch

New single-stage weekly workflow `db-backup` (category `regular-maintenance`, e.g. Sundays
04:00, BEFORE A01's heavy maintenance step):

1. **Online snapshot**: better-sqlite3's `db.backup(dest)` (WAL-safe, no daemon stop) — or
   `VACUUM INTO` — writing `data/backups/jobs-<date>.db`; rotate to the newest N
   (`LOCALJOBS_BACKUP_KEEP`, default 8).
2. Optionally tar each workflow's `data/out/` (skip `raw/`, `chrome-profile/`, `repos/`) on a
   monthly cadence — the corpora are the product.
3. **Off-box copy**: when `LOCALJOBS_BACKUP_DIR` is set (external volume / iCloud-synced dir /
   Time-Machine-visible path), copy the newest snapshot there; soft-warn if unmounted. The
   Mini's disk is the failure domain — an on-disk-only backup only covers corruption, not
   hardware.
4. Ledger row per backup with `detail.path` so backups appear in the workflow's Output section;
   the run's final log line reports sizes + rotation.
5. **README section "Backup & restore / moving to a new machine"**: what to copy (`jobs.db`,
   `data/` trees, `.env`, `chrome-profile/`), re-run the launchd installers, re-login Vercel
   CLI/Claude CLI. Note `.env` can't be committed (public repo) — the backup is what captures
   the machine's config.

Piggybacks naturally with A01's `wal_checkpoint(TRUNCATE)` ordering.

## Acceptance criteria

- A scheduled run produces a valid snapshot (openable by sqlite3, row counts match) while the
  daemon is live and children are writing.
- Rotation keeps exactly N; off-box copy happens when the dir exists, warns when not.
- Restore doc verified by actually restoring a snapshot to a scratch path and pointing a dev
  daemon at it.

## Test plan

Unit: rotation + naming logic. Integration: backup against the scratch DB under concurrent
writes (the executor tests' child-writer pattern). Manual once: the restore walkthrough.
