# B12: stocks-sync breach alerts — `::notified` ledger written one stage too early, and the push result is ignored

**Type**: bug · **Priority**: P1 · **Effort**: S
**Area**: workflows (stocks-sync)
**Affected files**: `src/workflows/stocks-sync/stages/stocks-watch.ts` (~104–121), `src/workflows/stocks-sync/stages/stocks-notify.ts` (~60–63)

## Problem

Two compounding defects in the gain-alert path:

1. **`stocks-watch` marks the episode notified before anything is sent.** On detecting a fresh
   breach it immediately records `markWorkItem(WATCH_JOB, notifiedKey, 'success', …)` — but the
   actual push happens one stage later, in `stocks-notify`.
2. **`stocks-notify` discards the push result.** `push()` (`src/core/notifier.ts` ~98–102)
   returns `{ ok, error }` and never throws; the stage does
   `await pushFn(digest.title, digest.body, {...});` without checking `ok`, then logs
   "notification sent" unconditionally — the log lies on failure.

**Failure scenarios**:
- Push fails (ntfy down) → the alert is lost, but the breach episode row exists, so that
  position will NEVER alert again until it drops below the 30% threshold and re-crosses it —
  potentially months of missed "you're up big" signal.
- The workflow run is cancelled (or crashes) between watch and notify → same silent loss.

The repo already has the correct pattern twice: `movies/stages/notify.ts` and
`missing-tv-seasons/stages/notify.ts` both verify the push succeeded and THROW before marking
their announce-once ledgers.

## Proposed fix

Preferred (matches the established pattern): move episode-marking into `stocks-notify` after a
verified-ok push — `stocks-watch` keeps writing `fresh-breaches.json` but stops writing
`::notified`; `stocks-notify` checks `res.ok`, throws on failure, and marks the episode rows
`success` only after a delivered push.

Minimal alternative: watch marks `::notified` as `'skipped'` (pending) and notify promotes it to
`'success'` after a verified push, throwing on failure.

Bonus cleanup in the same change: `formatBreachLine`/`buildDigest` are duplicated verbatim in
both stage files — watch's copies are dead code; keep one pair (export from one module).

## Acceptance criteria

- A failed push → run fails, no `::notified` episode row recorded, next run re-alerts.
- A cancelled run between the stages does not lose the alert.
- The "notification sent" log line only appears when `res.ok` is true.

## Test plan

Unit tests: failing `pushFn` → throw + no episode rows; ok `pushFn` → episode rows appear
exactly once; second run with rows present → no duplicate alert. Update any existing
stocks-watch/notify tests for the moved marking.
