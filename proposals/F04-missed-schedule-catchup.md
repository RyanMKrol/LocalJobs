# F04: Missed-schedule catch-up — a reboot at the wrong moment silently skips a monthly workflow for a month, and some time-window digests are then unrecoverable

**Type**: feature · **Priority**: P2 · **Effort**: M
**Area**: core (scheduler/daemon) / db
**Backlog cross-ref**: not tracked. Found independently by two agents.

## Problem

Croner fires only while the daemon is alive and replays nothing; the daemon never asks "did I
miss a tick?" at startup (it only reaps orphans). Sleep is mitigated by `pmset`, but reboots
(macOS updates), crashes (B09), and routine restarts (`kickstart -k` after every `src/` change —
the documented workflow) are not:

- A restart spanning 03:00 silently skips places' daily run until tomorrow — annoying.
- A monthly workflow (movie-recs, tv-recs, listening-digest, workouts — all 1st-of-month) that
  misses its single tick **doesn't run for a month** — bad.
- Worse, some time-window digests are then **unrecoverable**: listening-digest reads Last.fm's
  rolling `period=1month` and workouts-progress compares "the most recently completed calendar
  month" — run late enough and that month's view is gone; the sources only serve rolling
  windows.

Idempotent workflows make catch-up *safe* by construction; nothing makes it *happen*.

## Design sketch

Opt-in `catchUpOnMissed?: boolean` on `WorkflowDefinition` (default false — avoids boot
stampedes; enable on the monthlies + places):

1. At `startScheduler()` (and optionally hourly): for each enabled workflow with the flag,
   compute the most recent scheduled fire time before now (a paused croner instance answers
   this: previous occurrence of the EFFECTIVE schedule).
2. Compare against `MAX(started_at) WHERE trigger IN ('schedule','catchup')` for that workflow
   in `workflow_runs`.
3. If the last scheduled occurrence has no run after it → enqueue ONE catch-up run (a new
   `'catchup'` trigger value for honest history — additive to the trigger comment, see Q01),
   staggered a few minutes post-boot, respecting the one-active-run guard and the global
   ceiling (F09) if present.
4. One catch-up, never a backlog replay (missing three weeks of a weekly = one run — the
   ledgers make that correct).

The alternative `last_fired_at` column design (persist fire times, compare at boot) is
equivalent; the `workflow_runs`-derived version needs no schema change. Either is fine — pick
during implementation.

## Acceptance criteria

- Simulated: daemon down across a monthly boundary → one `catchup`-triggered run at next boot;
  daemon down across nothing → zero catch-ups.
- Catch-up respects `enabled`, the one-active-run guard, and produces normal notifications.
- Dashboard run history shows the `catchup` trigger distinctly.

## Test plan

`scheduler.test.ts`: fake clock/schedule pairs (missed daily, missed monthly, not-missed);
store test for the "last scheduled run after T?" query; one end-to-end against the scratch DB.
