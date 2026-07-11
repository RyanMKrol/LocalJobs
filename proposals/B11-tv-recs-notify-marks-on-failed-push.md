# B11: `tv-recs-notify` marks recommendations notified even when the push FAILS — the month's recs are silently lost forever

**Type**: bug · **Priority**: P1 · **Effort**: S
**Area**: workflows (tv-recs)
**Affected files**: `src/workflows/tv-recs/stages/tv-recs-notify.ts` (~89–113)

## Problem

```ts
const res = await pushFn(digest.title, digest.body, { job: 'tv-recs', ... });
ctx.log(res.ok ? `digest push sent — ...` : `digest push FAILED (${res.error})`, res.ok ? 'info' : 'error');
// Mark each notified rec in the ledger so it's never re-notified.
for (const r of newRecs) { markWorkItem(RECS_JOB, recKey(r.tmdbId), 'success', {...}); }
appendHistory(historyFile, newRecs, now);
```

The push result is logged but not acted on: on `res.ok === false` the stage still records every
rec `success` in the announce-once ledger AND appends them to `recs-history.json` (which the
branches use to avoid re-suggesting).

**Failure scenario**: ntfy is down/unreachable during the monthly run → the digest never reaches
the owner, yet every recommendation is permanently marked notified and history-logged. The
month's recommendations are silently lost; `maxRetries: 3` never engages because the run
"succeeds"; the next chance is next month, with fresh (different) recs.

**Why this is clearly a bug, not a choice**: both sibling implementations guard exactly this —
`movies/stages/notify.ts` (~151–156) and `missing-tv-seasons/stages/notify.ts` (~100–103) THROW
on a failed push BEFORE marking the ledger (the missing-tv-seasons one is the documented model
implementation of the notify-ledger pattern). tv-recs was built mirroring movies and missed the
guard — a direct casualty of the movies↔tv-recs copy-paste duplication (see R01).

## Proposed fix

```ts
if (!res.ok) throw new Error(`Digest push failed — ${res.error}`);
```

immediately after the push, before the mark loop and `appendHistory`. The run then fails
honestly, retries via `maxRetries`, and the next scheduled run re-notifies (ledger rows were
never written).

## Acceptance criteria

- A failed push → run fails, ledger untouched, history untouched; the next run re-sends the same
  recs.
- A successful push → behavior unchanged.

## Test plan

Mirror the existing movies failed-push test (`movies/stages/notify.test.ts`) for tv-recs: inject
a failing `pushFn`, assert the throw, assert `isWorkItemDone` is false for every rec, assert the
history file is unchanged.
