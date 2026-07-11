# B24: No single-daemon-instance enforcement — a second daemon's startup reaps the first daemon's LIVE runs before failing on the port

**Type**: bug · **Priority**: P3 · **Effort**: S
**Area**: core
**Affected files**: `src/daemon.ts` (~25–29: reap → startScheduler → startApi order), `src/db/store.ts` (~414–422), `src/api/server.ts` (~1563–1567)

## Problem

`main()` runs `reapOrphanRuns() + reapOrphanWorkflowRuns()` — which assumes any `running` row is
a crash leftover — **before** `startApi()` would fail on the occupied port. Start a dev daemon
(`npm run daemon`) while the launchd daemon is mid-run (a mistake this repo's dev workflow
actively invites — CLAUDE.md's restart idiom has you touching the daemon regularly) and the
second process:

1. immediately marks every live run `cancelled` / "Orphaned by daemon restart" in the shared DB,
2. starts its own scheduler (duplicate cron fires possible in the window),
3. then dies on `EADDRINUSE` — which is an unhandled `'error'` event on the HTTP server, i.e.
   another ungraceful crash with a confusing stack.

The first daemon later overwrites statuses at `finishRun`/`finishWorkflowRun` (UPDATE by id), so
the damage is mostly transient mislabeling — but during the window `hasActiveWorkflowRun` is
false, weakening the one-active-run duplicate protection.

## Proposed fix

Reorder + guard:

1. Bind the API port FIRST (or take an exclusive lockfile) — only then reap orphans and start
   the scheduler.
2. Handle `listen`'s `'error'` event: on `EADDRINUSE`, print a clear
   "another daemon is already running (port 4789 busy) — exiting" and `process.exit(1)` cleanly.

## Acceptance criteria

- Starting a second daemon while one runs: exits immediately with the clear message, touches ZERO
  run rows, registers no crons.
- Normal startup order (no contention) behaves identically to today.

## Test plan

Integration-style test: bind a throwaway server on the configured port, run daemon `main()`
against a scratch DB seeded with a `running` row, assert the row is untouched and the process
exit path was the clean one.
