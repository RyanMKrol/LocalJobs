# A04: Retries are immediate with zero backoff — a transient failure burns all attempts in seconds; deterministic timeouts re-run for 40 wasted minutes

**Type**: arch/quality · **Priority**: P3 · **Effort**: S
**Area**: core
**Affected files**: `src/core/executor.ts` (`runAttempts` ~44–65)

## Problem

```ts
if (attempt <= maxRetries) {
  addLog(runId, `Attempt ${attempt} ${outcome.status}; retrying...`, 'warn');
  continue;   // immediate respawn
}
```

- A job failing instantly (bad credential, missing file, unreachable host) burns all attempts
  within seconds — `maxRetries: 3` means 4 back-to-back child spawns with zero chance for a
  transient condition (network blip, Plex waking from a lease change) to clear. The retry budget
  buys nothing against exactly the failures it exists for.
- A `timeout` outcome retries identically: `timeoutMs: 600_000` + `maxRetries: 3` can occupy the
  workflow slot for 40 minutes of guaranteed-doomed reruns when the hang is deterministic.

## Proposed fix

Exponential backoff between attempts in `runAttempts`:

```ts
const delay = Math.min(base * 2 ** (attempt - 1), cap);   // e.g. base 5s, cap 120s, jittered
await sleepRacingAbort(delay, signal);                     // cancellation must not wait out the backoff
```

- Race the abort signal so cancelling a workflow isn't delayed by a pending backoff.
- Optional per-job `retryDelayMs` on `JobDefinition` for jobs that know better.
- Keep retrying timeouts (a slow-that-day scrape is real) but log the distinction; optionally a
  smaller attempt budget for `timeout` outcomes.
- Env-tunable (`LOCALJOBS_RETRY_BASE_MS` / `_CAP_MS`) via the B19 `envInt` helper.

## Acceptance criteria

- Failed attempts are spaced by the backoff schedule (observable in run logs' timestamps).
- Cancelling mid-backoff settles the run `cancelled` immediately.
- Total added latency for a genuinely-doomed 3-retry job stays bounded (~<5 min with defaults).

## Test plan

`executor.test.ts`: fake failing job, assert inter-attempt gaps (with a small injected base);
cancellation-during-backoff test.
