# Manual-fail signal (owner correction of a falsely-recorded success)

How the owner overturns a task the harness recorded as **done** but that actually **failed** — and
why that correction feeds back into difficulty tuning and audit sampling rather than just flipping a
flag.

## 1. The problem

The harness records every task it finishes as a terminal outcome in `outcomes.jsonl`, and that ledger
is the **sole input to calibration** (see `difficulty-autotune.md` and `audit-verification.md`). A
`mark_done` writes a **success** row (`blocked:false`); that row does two things going forward:

1. **Difficulty tuning** treats the task's final model tier as *sufficient* for its
   `(layer × workType)` cell — so the policy keeps starting similar tasks at that (often cheap) tier.
2. **Audit sampling** counts it (when `verification:"audited"`) toward the cell's confirmed-audited
   successes — and the more confirmed successes a cell has, the *less often* it gets audited (100%
   decays toward a 10% floor).

The audit gate (`audit-verification.md`) exists to stop **false successes** — the cheap model shipping
plausible-but-wrong work that compiles, passes tests, and is green in CI. But the audit is *sampled*
and the auditor reads only a **text diff**, so some false successes still get through — especially
visual/UI bugs an auditor can't see in a diff (e.g. an element present in the DOM but never painted).
When that happens, the false success is **silent and compounding**: it tells the tuner "the cheap tier
works here" *and* it suppresses future auditing of exactly the cell that just shipped a bug. Failure is
self-correcting (the ladder escalates); a false success is not.

The owner is the backstop. When they look at a finished task and judge it not actually done, the
harness needs a way to learn from that — not just a cosmetic "rejected" flag.

## 2. The signal: an owner-owned overlay the loop reads, never writes

A task is marked failed in **`.harness/tracking/manual-fail.json`** — a committed, owner-owned map:

```json
{ "T223": { "failed": true, "reason": "padlock never renders on the DAG", "at": "2026-06-29T…Z" } }
```

This is the **third sibling** to `reviews.json` (T136) and `human-done.json` (T208): a committed
overlay on a git path **disjoint** from everything the loop writes (`TASKS.json` status, the worklog,
`outcomes.jsonl`, `failures.jsonl`). The loop **never writes** it; it only **reads** it. This keeps
the long-standing decoupling intact — the loop owns status + the ledgers, the owner owns the overlays —
so the writers never conflict.

Crucially, the correction is **retroactive without mutating the append-only ledger.** The task already
has a `blocked:false` success row in `outcomes.jsonl`; we do **not** rewrite that file (it's loop-owned
and forward-only) and we do **not** append a contradictory failure row (the calibrator doesn't dedupe by
id, so that would double-count). Instead, the ledger's two **readers** subtract the overlay at read time.

## 3. What the correction does

Both calibration readers honor the overlay (`loop.sh` + `policy.jq`):

- **Difficulty tuning (`pick_base` → `policy.jq`, `$failedIds`).** A manually-failed id's success row is
  re-interpreted as a failure at every rung it used — exactly as if it had been `blocked`. So the cell's
  measured success rate at that tier drops, and the policy will pick a **stronger start tier** for future
  tasks in the cell instead of the tier the false success vouched for.
- **Audit sampling (`audit_gate` count query).** The cell's confirmed-audited count **excludes**
  manually-failed ids, so a false "audited success" stops suppressing the cell's audit rate. The sampling
  probability climbs back toward 100%, so that category gets **scrutinised more often** again.

Net effect: marking a UI task failed makes future UI tasks both **built with a stronger model** and
**audited more aggressively** — directly targeting the conditions that let the bug through.

## 4. What it deliberately does NOT do

- **It does not RE-OPEN the task.** (Update — T279: the loop now DOES reconcile the overlay into
  `TASKS.json` `status=failed` at pre-flight via `reconcile_overlays`, mirroring T261's human-done →
  `status=done` reconcile, so `TASKS.json` status is the authoritative state. But `failed` is
  **terminal** — the loop SKIPS it, it does NOT re-build/auto-reopen the task. The dashboard still
  writes only the overlay; the loop is the sole `TASKS.json` writer, so the decoupling holds. The
  re-do of failed work is a separate follow-up task, never an auto-reopen.)
- **It does not feed the failure reason into the auditor's prompt.** The correction is purely the
  sampling-rate + tier bump above; teaching the auditor *what to look for* from past reasons is a possible
  future extension, not part of this design.
- **It is never automatic.** Nothing in the run/schedule path marks a task failed. It is an explicit
  owner action only.

## 5. Interfaces

- **Dashboard (this project):** a **"Mark failed"** button on the Backlog page → `POST
  /api/backlog/:id/failed` → the overlay file, committed + pushed `[skip ci]` under the **shared repo
  lock** (`repo-lock.ts` / the loop's `acquire_lock`) so it never races the loop. Restricted to `done`
  tasks (you're overturning a recorded success); a failed task shows a red chip and counts as
  reviewed.

A portable, no-dashboard interface (`.harness/scripts/mark-failed.sh <TNNN> "<reason>"` +
`--undo`, driven by the `/local-jobs-mark-task-failed` Claude command) used to exist alongside the
dashboard button, sharing the loop's lock + paths (sourced with `LOOP_SOURCE_ONLY=1`). Both were
**removed** — every project running this harness now has a dashboard, so the second interface was
unused dead weight. If a genuinely dashboard-less project needs this again, re-derive it from this
design's overlay-file shape rather than resurrecting the deleted script verbatim (the removal reason
was "nobody uses it", not "the approach was wrong").

Validates that the target is a real `done` task. `manual-fail.json` seeds as `{}` and is committed.

## 6. Why this shape

- **Retroactive + non-destructive:** corrects already-written history without touching the append-only,
  loop-owned ledger — the readers subtract the overlay.
- **Decoupled:** a disjoint, owner-owned file, exactly like `reviews.json`/`human-done.json`; no new
  contention with the loop.
- **Portable in principle:** the mechanism is a JSON overlay + jq reads, so a project that adopts this
  harness could get the full benefit with no dashboard, daemon, or database via a small script
  reading/writing the same overlay shape — the dashboard button is a convenience layer over that
  file, not the file's only possible writer. (The actual portable script + command that used to
  provide this were removed as unused — see §5.)
