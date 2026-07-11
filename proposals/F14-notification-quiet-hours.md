# F14: Notification quiet hours + overnight batching — a 2am perfumes failure pushes at 2am

**Type**: feature · **Priority**: P3 · **Effort**: S
**Area**: core (notifier)
**Backlog cross-ref**: not tracked.

## Problem (small, honestly)

Notification maturity is already decent: aggregate-only per run (T189), per-workflow on/off
(T285), priority split (success quiet, failure high), 429 backoff (T114). What's missing is
time-shaping: perfumes runs at 02:00, places at 03:00, vercel-redeploy at 23:00 — a failure
pushes in the middle of the night; and there's no "3 things failed overnight" morning summary.
Counter-argument: ntfy clients mute on-device and T285 already tamed the noisy workflows — this
is polish, not pain.

## Design sketch

`LOCALJOBS_QUIET_HOURS="23-08"` (unset = off):

- Inside the window, `notifyWorkflow` writes to a small `deferred_notifications` table instead
  of sending (failures optionally exempt via `LOCALJOBS_QUIET_BREAKTHROUGH=failures`).
- At window end, a daemon timer flushes ONE combined "overnight summary" push (per-workflow
  lines, worst status first) and clears the table.
- All in `notifier.ts` + one additive table + one timer; global and dumb — no per-workflow
  quiet config (T285's toggle already exists for "never notify").
- macOS notification path (osascript) follows the same gate.

## Acceptance criteria

- A success push at 02:30 with the window set: nothing sent, row queued; at 08:00 one summary
  arrives containing it.
- With `QUIET_BREAKTHROUGH=failures`, a failure at 02:30 pushes immediately and is excluded
  from the morning summary.
- Unset env → byte-identical behavior to today.

## Test plan

`notifier.test.ts`: window math (incl. midnight wrap), queue/flush, breakthrough path, unset
regression.
