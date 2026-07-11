# B09: Crash-proof the daemon — cron-callback rejections, unhandled rejections, and store throws in stream handlers can each kill the whole process

**Type**: bug · **Priority**: P1 · **Effort**: S
**Area**: core
**Affected files**: `src/core/scheduler.ts` (~36–41), `src/daemon.ts` (no global handlers), `src/core/executor.ts` (readline handlers ~161–189)

## Problem

Three independent channels let one localized failure take down the entire daemon (and with it,
every concurrently-running workflow):

1. **Scheduler path (verified against installed croner v8).** The cron callback awaits
   `runWorkflow` with no try/catch, and croner's default is `catch: false` — `_checkTrigger`
   calls `this._trigger()` fire-and-forget with no `.catch()`, so a rejection from the callback
   becomes an **unhandled promise rejection**:
   ```ts
   const cron = new Cron(schedule, { name: `workflow:${def.name}` }, async () => {
     const row = getWorkflow(def.name);          // sync DB read, can throw
     if (!row || row.enabled === 0) return;
     const result = await runWorkflow(def, 'schedule');   // can reject (see B08)
   });
   ```
2. **No global handlers.** `src/daemon.ts` installs neither `process.on('unhandledRejection')`
   nor `process.on('uncaughtException')`; Node's default (≥ v15) terminates the process.
3. **Synchronous store throws in stream handlers.** The daemon calls `addLog`/`setProgress`
   inside `rl.on('line')` (executor.ts ~161–189). A better-sqlite3 throw there (SQLITE_BUSY past
   the 5 s timeout while ≥4 children write) is a synchronous exception in an event handler — not
   routed to any promise — i.e. an `uncaughtException`.

**Failure scenario**: one flaky DB moment in one workflow → daemon exits → launchd's group-kill
tears down every running child → launchd restarts the daemon → all in-flight runs get reaped as
`cancelled` ("Orphaned by daemon restart"). Multi-hour runs of unrelated workflows are lost to a
transient hiccup elsewhere.

## Proposed fix

1. Wrap the cron callback body in try/catch (log to daemon console + a `notifyWorkflow`-style
   failure push is optional), or pass `catch: (e) => console.error(...)` in the Cron options.
2. Add last-resort handlers in `daemon.ts`:
   `process.on('unhandledRejection', log)` and `process.on('uncaughtException', e => { log; })` —
   decide deliberately whether uncaughtException should exit(1) after logging (launchd restarts
   it) or attempt to continue; either way it must LOG loudly first. Pairs with F06
   (watchdog/health alerting) which adds an ntfy push on crash-restart.
3. try/catch the store calls inside the `rl.on('line')` handlers — dropping one log line beats
   killing the daemon.

## Acceptance criteria

- A scheduled workflow whose `runWorkflow` rejects logs the error and the daemon keeps running;
  other workflows' schedules are unaffected.
- A throwing `addLog` during log streaming loses at most that line.
- Simulated unhandled rejection does not terminate the daemon silently.

## Test plan

`scheduler.test.ts` never exercises a throwing fire — add one (fake workflow whose run rejects;
assert the scheduler survives to the next tick). Unit-test the line-handler guard with a
monkey-patched `addLog` that throws.
