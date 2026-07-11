# B18: Service day/month quota is check-then-act across processes — paid caps can be exceeded under concurrency, and quota is never re-checked after a rate-limit wait

**Type**: bug · **Priority**: P2 · **Effort**: S
**Area**: core / db
**Affected files**: `src/core/services.ts` (~138–158), `src/db/store.ts` (~1676–1790)

## Problem

(Found independently by two review agents.) The rate-per-minute and min-interval reservations
are genuinely atomic — `_reserveSlotTx` / `_reserveIntervalTx` count + insert inside single
IMMEDIATE transactions. The day/month **quota** gate is not:

```ts
if (monthlyCap != null) {
  const m = serviceCallsThisMonth(name);   // plain read
  if (m >= monthlyCap) throw new QuotaExceededError(...);
}
// ...usage row inserted later, by the reservation or recordServiceCall
```

Two windows:

1. **Concurrent check-then-act**: with `maxConcurrency` 4 (plus different workflows running
   simultaneously), N child processes can all read `m = cap − 1`, all pass, all insert →
   overshoot bounded by (concurrent callers − 1).
2. **Stale-after-wait**: a caller can wait up to `maxWaitMs` (5 min default) in the rate-slot
   loop AFTER passing the quota check, and quota is never re-checked at slot acquisition —
   others may exhaust the month meanwhile.

Overshoot is small in practice (pennies), but CLAUDE.md states "monthly quotas are enforced
GLOBALLY across processes" and the harness rule treats the cap as a hard ceiling ("never exceed
a service's monthly cap"). The enforcement is best-effort under concurrency; the invariant says
guarantee.

## Proposed fix

Fold the quota check into the same IMMEDIATE transactions that record usage:

- Extend `_reserveSlotTx` / `_reserveIntervalTx` to take `(dailyCap, monthlyCap)` and return
  `'ok' | 'rate-busy' | 'quota-daily' | 'quota-monthly'` — the check and the insert become one
  atomic unit, and re-checking after a wait falls out for free (each retry re-runs the
  transaction).
- For the no-rate-limit path, a small `reserveQuota` transaction replaces the bare
  `recordServiceCall`.
- `callService` maps the quota results to `QuotaExceededError` exactly as today.

## Acceptance criteria

- Two concurrent processes at `monthlyCap − 1` result in exactly ONE recorded call and one
  `QuotaExceededError` (test with two better-sqlite3 connections on one DB file).
- A caller that waited for a rate slot while another exhausted the month gets
  `QuotaExceededError`, not a recorded over-cap call.
- Existing `services.test.ts` quota/rate tests still pass.

## Test plan

Add the two-connection race test to `services.test.ts` (the reviewing agent confirmed this is
feasible); keep all existing quota semantics tests green.
