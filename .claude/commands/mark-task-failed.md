---
description: Mark a DONE harness task as FAILED — the owner's "this wasn't actually done" correction
argument-hint: <TNNN> "<what was actually wrong>"   (or: --undo <TNNN>)
---

The owner wants to mark a completed harness task as **failed** (or undo a previous mark). Arguments:

$ARGUMENTS

## What this is

The autonomous build harness (the "Ralph loop") records every task it finishes as a **success** in
its calibration ledger (`.harness/outcomes.jsonl`). Sometimes a task is marked `done` and passes CI
+ the sampled audit, yet the owner looks at the result and judges it **not actually done** (e.g. a
UI element that's in the DOM but never renders). Left uncorrected, that false success quietly
degrades the harness: it teaches the difficulty tuner that the cheap model works for that kind of
task, and it suppresses how often that category gets audited — so the same class of bug keeps
slipping through.

**Marking a task failed is the correction.** It writes the task into the owner-owned overlay
`.harness/manual-fail.json`, which the loop READS (never writes) to:
1. **Re-count that task as a failure for difficulty tuning** — so future tasks in the same
   `(layer × workType)` cell start at a **stronger model tier**, not the cheap one a false success
   vouched for.
2. **Drop it from the cell's confirmed-audited count** — so the harness **audits that category more
   often** again (a false "audited success" had been pushing the audit rate down).

It does **NOT** change the task's `status` or re-open it for a rebuild — the loop owns task status,
and re-opening is deliberately out of scope. After marking it failed, either fix the work yourself or
author a follow-up task with `/convert-ideas` (or the add-to-backlog skill).

## How to do it

There is a portable helper script that does the whole thing — write the overlay entry, then
commit + push it `[skip ci]` under the **same repo lock the loop uses** (so it never races the loop's
git operations). It needs no dashboard and no daemon. Run it from the repo root:

```bash
# Mark a done task failed (a reason is REQUIRED — say what was actually wrong):
.harness/mark-failed.sh <TNNN> "<concise reason>"

# Undo a previous mark:
.harness/mark-failed.sh --undo <TNNN>
```

Steps for you (Claude) to follow:
1. **Parse the arguments** into a task id (`T<digits>`) and a reason (everything after the id), or an
   `--undo <TNNN>` form. If the owner gave a task id but no reason for a (non-undo) mark, ASK them for
   a one-line reason before running — the reason is mandatory and is the record of what was wrong.
2. **Run `.harness/mark-failed.sh`** with those arguments (it validates that the id exists and is a
   `done` task, writes `.harness/manual-fail.json`, and commits + pushes under the lock). If the
   script reports the task isn't `done`, relay that — only recorded successes can be overturned.
3. **Report** what was marked (id + reason), and that it was committed/pushed. Briefly note the
   effect: the task's `(layer × workType)` cell will now be built with a stronger model and audited
   more often. Mention that the task's status is unchanged — if they want it rebuilt, that's a
   separate fix or follow-up task.

## Notes

- This is **owner-driven only** — never mark a task failed on your own initiative; only when the
  owner explicitly asks.
- The overlay (`.harness/manual-fail.json`) is **committed** (like `reviews.json`/`human-done.json`),
  on a git path disjoint from everything the loop writes, so it never conflicts with the loop.
- Projects with the dashboard can also do this from the Backlog page's **"Mark failed"** button,
  which writes the same overlay file. The script and the button are interchangeable.
- Full design + rationale: `.harness/designs/manual-fail-signal.md`.
