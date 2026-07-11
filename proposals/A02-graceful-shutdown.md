# A02: Graceful shutdown — SIGTERM currently exits immediately, orphaning children and mislabeling runs

**Type**: arch · **Priority**: P2 · **Effort**: S
**Area**: core / daemon
**Affected files**: `src/daemon.ts` (~31–37), `src/core/workflow-executor.ts` (`activeWorkflowRuns` ~134)

## Problem

```ts
const shutdown = (signal: string) => {
  console.log(`[daemon] ${signal} received — shutting down`);
  stopScheduler();
  process.exit(0);
};
```

No abort of the controllers in `activeWorkflowRuns`, no SIGTERM to spawned children, no HTTP
server close, no wait. Consequences:

1. **Dev mode (`npm run daemon`) has no safety net**: Ctrl-C orphans every in-flight job child,
   which keeps writing `work_items`/`service_usage` while the restarted daemon reaps its run row
   as `cancelled` — and may **start the same job again concurrently** (the overlap guard is
   DB-status-based; after the reap, `hasActiveRun` is false).
2. Under launchd the group-kill limits the damage, but the shutdown path records nothing: runs
   stay `running` and are only labeled "Orphaned by daemon restart" at *next* startup — a
   deliberate `launchctl kickstart -k` (the documented restart idiom, used after every `src/`
   change) is indistinguishable from a crash in the run history.
3. `stopScheduler()` immediately followed by `process.exit(0)` is cosmetic.

## Proposed fix

In `shutdown`:

1. `stopScheduler()`.
2. `for (const c of activeWorkflowRuns.values()) c.abort()` — the existing cancellation
   machinery already hard-kills children (SIGTERM→SIGKILL) and records member runs + the
   workflow run `cancelled` via the normal executor path, preserving the sole-writer invariant.
3. Await drain (bounded, ~10 s) of `activeWorkflowRuns`; export small
   `abortAllWorkflowRuns()` / `activeWorkflowRunCount()` helpers from workflow-executor.
4. Close the HTTP server; then exit.

This turns restart-mid-run from crash semantics into a first-class cancel — honest history, no
orphans, no duplicate-run window.

**⚠ Coordinate with B10** (process-group kill / `detached: true`): once children are detached,
launchd's group-kill no longer covers them, making this proposal load-bearing rather than
nice-to-have. Land A02 with or before B10.

## Acceptance criteria

- `kill -TERM <daemon>` mid-run: children die, member + workflow runs recorded `cancelled`
  (with a shutdown-specific message), exit within the bound.
- Next startup reaps nothing (nothing left `running`).
- `launchctl kickstart -k` produces clean `cancelled` history instead of "Orphaned by daemon
  restart".

## Test plan

Extract `shutdown` so it's testable without `process.exit` (inject an exit fn) — the core
reviewer noted it's currently untestable as written. Unit test: fake active run + abort spy +
drain. Manual: kickstart mid-run of a long fake workflow, inspect run history.
