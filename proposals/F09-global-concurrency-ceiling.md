# F09: Global concurrency ceiling across workflows — per-workflow caps compose into unbounded machine contention

**Type**: feature · **Priority**: P3 · **Effort**: S
**Area**: core
**Backlog cross-ref**: not tracked.

## Problem

Concurrency is capped per-workflow (`maxConcurrency`), and the one-active-run guard is
explicitly per-workflow. Different workflows stack freely: Sundays host projects-sync 05:00,
plex-space-saver 06:00, overrides-audit 07:00 — deliberately hand-offset crons, which is
evidence the owner is already manually managing this scarcity; the 1st-at-09:00 fires
movie-recs AND tv-recs together = up to 8 concurrent Claude-CLI children plus snapshots; and
Admin's "Run all workflows" starts everything at once. Service quotas pace paid *calls*, not
CPU/RAM/headless-browser contention on the Mini. Hand-offsetting doesn't compose as workflows
keep being added.

## Design sketch

A daemon-global counting semaphore around child spawn in `executor.ts`
(`LOCALJOBS_GLOBAL_MAX_CHILDREN`, default 6; 0 = off):

- `executeDag` already queues excess ready stages per-workflow — extend the same wait to a
  shared token pool; a stage that's ready but ceiling-blocked logs "waiting for a global slot"
  to its workflow's framework log.
- Deliberately dumb: a ceiling, not priorities or queue classes. FIFO wakeup is fine.
- Abort-aware: a cancelled workflow's queued waiters release immediately.

No DB or API change; document the env var (D03) and the behavior (CLAUDE.md concurrency
section).

## Acceptance criteria

- With the ceiling at 2 and three single-stage workflows started together, at most 2 children
  exist at any instant (observable via the executor's spawn hook in tests); all three complete.
- `0` disables the mechanism entirely.
- Cancellation of a waiting workflow releases its slot request.

## Test plan

`executor.test.ts`/`workflow-executor.test.ts`: fake slow children + ceiling 2 + spawn-count
assertion over time; cancellation-while-queued case.
