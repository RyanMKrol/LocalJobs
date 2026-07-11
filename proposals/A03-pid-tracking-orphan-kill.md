# A03: Orphan reaping is DB-only — record child PIDs so a restarted daemon can detect and kill still-alive children instead of blindly relabeling rows

**Type**: arch · **Priority**: P2 · **Effort**: S
**Area**: core / db
**Affected files**: `src/db/store.ts` (`reapOrphanRuns` ~414–422), `src/daemon.ts` (~25–26), `src/db/schema.sql` (+ migration: `runs.child_pid`), `src/core/executor.ts` (record pid at spawn)

## Problem

`reapOrphanRuns` flips every `running` run to `cancelled` at startup, purely in SQL. The `runs`
table stores no child PID, so there is no way to check whether an "orphaned" child is actually
still alive — which happens whenever the daemon died without launchd tearing down the process
group (dev mode, `kill -9` of just the daemon PID, or after B10 makes children detached
process-group leaders). Once reaped:

- `hasActiveRun(jobName)` (status-based) returns false → the next scheduled/manual run **starts
  a second child of the same job while the first is still alive**. Jobs are idempotent so
  corruption is unlikely, but ledger attempt counters and `data/out` writes can interleave in a
  way no other path permits.
- The surviving child keeps writing `markWorkItem`/`service_usage` rows attributed to a run
  already labeled "Orphaned by daemon restart".

## Proposed fix

1. Migration: add nullable `child_pid` (and, with B10, the process-group id) to `runs` —
   additive `ALTER TABLE` per the T098 rule.
2. `executor.ts`: record `child.pid` on the run row at spawn (one UPDATE).
3. Startup reap becomes: for each `running` row with a pid, probe `process.kill(pid, 0)`;
   SIGTERM→SIGKILL survivors (bounded escalation, reusing the kill-path shape), THEN flip the
   row — message distinguishes "killed surviving orphan child (pid N)" from "process already
   gone".
4. Guard against PID reuse: cheap sanity check that the probed process looks like ours
   (e.g. `ps -o command= -p PID` contains `runJob`) before killing — PIDs recycle.

Pairs naturally with B10 (group kill) and A02 (graceful shutdown): together they close the
orphan-children story end-to-end.

## Acceptance criteria

- A `running` row whose recorded child is alive at daemon startup → child killed, row reaped
  with the "killed surviving orphan" message.
- A dead-pid row → reaped exactly as today.
- No kill is issued when the pid now belongs to an unrelated process.

## Test plan

Unit test with a real spawned `sleep`-style child: seed a running row with its pid, run the
reaper, assert the process is gone; a second test with a recycled-looking pid (spawn+wait so the
pid is free) asserting no signal was sent to anything (mock `process.kill`).
