# B10: Timeout/cancel kill path signals only the direct child — headless Chrome, `claude` CLI, and `git clone` grandchildren get orphaned

**Type**: bug · **Priority**: P2 · **Effort**: S
**Area**: core
**Affected files**: `src/core/executor.ts` (spawn ~127–131, kill paths ~138–156), `src/core/browser.ts` (stale-lock cleanup ~83–86 — evidence this already happens)

## Problem

```ts
const child = spawn(process.execPath, ['--import', 'tsx', config.runJobScript, jobName],
  { stdio: ['ignore', 'pipe', 'pipe'], env });
...
child.kill('SIGTERM');
setTimeout(() => child.kill('SIGKILL'), 3000).unref();
```

`spawn` without `detached: true` + `child.kill(sig)` signals only the tsx/node child PID.
Several shipped jobs spawn their own subprocesses: Playwright Chrome (`core/browser.ts` →
`launchPersistentContext`), the Claude CLI (`services/claude.ts`), `git clone` (projects-sync),
`osascript` (notifier). Playwright's signal handlers can close Chrome on a *clean* SIGTERM, but
**SIGKILL cannot be handled** — and the 3 s escalation fires exactly when the child failed to
die promptly, i.e. exactly when Chrome is most likely to survive.

**Failure scenario**: `perfumes-fetch` hangs on a Cloudflare interstitial past its `timeoutMs`;
executor SIGTERMs the child; the child is blocked awaiting the page and doesn't exit in 3 s;
SIGKILL reaps the node child; headless Chrome (a grandchild) survives indefinitely — the daemon
is long-lived so launchd's group-kill never triggers. An orphaned `claude` CLI similarly keeps
burning the metered usage window unobserved. The stale-`Singleton*`-lock cleanup in `browser.ts`
is direct evidence orphaned Chromes already occur in practice.

## Proposed fix

Spawn with `detached: true` (child becomes its own process-group leader) and kill the group:
`process.kill(-child.pid, 'SIGTERM')`, escalating with `process.kill(-child.pid, 'SIGKILL')`;
guard `ESRCH` (group already gone).

**⚠ Interaction with A02/A03**: detached children will NOT be reaped by launchd's group-kill on
daemon death. Land this together with the graceful-shutdown abort (A02) and/or PID tracking
(A03) so a dying daemon still takes its children with it.

## Acceptance criteria

- A job child that spawns a long-lived grandchild (test with `sleep`) and then exceeds
  `timeoutMs` leaves NO surviving processes after the kill escalation.
- Normal (non-timeout) runs are unaffected; exit codes and NDJSON handling unchanged.

## Test plan

Extend `executor.test.ts`'s timeout tests: fake job script that spawns `sleep 300` and then
hangs; after the run settles, `process.kill(grandchildPid, 0)` must throw ESRCH.
