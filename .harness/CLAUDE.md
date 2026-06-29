# .harness/CLAUDE.md — rules for working *inside* the build harness

Loaded whenever Claude works with files in `.harness/` — notably when adding or editing backlog
tasks in `TASKS.json`. It keeps the harness's own authoring rules *with* the harness, so they travel
with it and surface at the authoring moment. (Repo-wide conventions are in the root `CLAUDE.md`; the
loop's design is in `HARNESS.md` + `designs/`.)

## Adding a backlog task → invoke the add-to-backlog skill

To add a task to the backlog, invoke the **`ralph-loop-add-to-backlog`** skill. It is the **single
source of authoring logic**: it assigns the task's **facets** (difficulty auto-tuning), pairs every
chooser task with a review task, runs the **poor-fit / layer-evolution gate**, and writes a
schema-correct task object + its `tasks/TNNN.md` spec. Prefer it over hand-editing `TASKS.json`.

## Ideas inbox & the two-step flow (ideas → tasks)

Tasks are NOT authored directly from a raw thought. A backlog task carries a high planning bar
(spec MD with `## Do`/`## Done when`, `scope`, `dependsOn`, `facets`, `verify`), so a half-formed
idea dumped straight in — especially several at once — produces rushed, low-quality specs. We split
capture from planning into **two deliberate steps**, with **ideas as a first-class harness concept**.

### Step 1 — capture: the ideas inbox (`.harness/IDEAS.md`)

A **gitignored**, zero-ceremony scratchpad: a single `## Inbox` list, one bullet per idea, as detailed
as needed (the full idea + any helpful context), no schema and no planning. It is the low-friction
place to dump a thought so it isn't lost and isn't interrupting in-flight work — capture is
**non-interactive** (it enriches from what's already known, never by asking) precisely so it doesn't
derail whatever Claude is mid-task on. Capture two ways:
- **`/idea <the idea, in as much detail as you like>`** — appends a bullet to the Inbox.
- Or just **hand-edit** `.harness/IDEAS.md`, or tell Claude "add an idea: …".

It is **gitignored on purpose** (like `data/` folders): raw, unfleshed ideas — which may reference
private jobs — stay local and never hit the public repo. The *mechanism* travels with the harness via
this committed doc; each project grows its own private inbox. This is distinct from the committed
`TASKS.json` backlog — the inbox is transient working state, the backlog is the durable record.

### Step 2 — convert: a per-idea TWO-PHASE interview, looped over the whole inbox (`/convert-ideas`)

Conversion is its OWN process — it **leans on `ralph-loop-add-to-backlog` but is NOT the bare skill**.
`/convert-ideas` sweeps the **whole inbox** in one invocation, but converts the ideas **one at a
time**: each idea gets its own full excavation before any shaping. The batch is purely an ergonomic
loop — it never lets you shape several half-formed ideas at once. For each idea, a probing front-end
runs first:
- **Phase 1 — idea excavation.** Treat the idea as one vague sentence. Probe the owner FIRST: what's
  the underlying itch/problem, what are they actually after, rough shape, why it matters — *before*
  any task-shaping. Default to MORE questions here; assume nothing is fleshed out. (This phase is
  exactly what the standard add-to-backlog interview lacks — it expects an already-formed feature.)
- **Phase 2 — task shaping.** Feed the now-understood idea into the **`ralph-loop-add-to-backlog`**
  interview (DoD, scope, dependsOn, facets, spec MD) → a schema-correct task. Related ideas (one a
  foundation the other builds on) become a `dependsOn` edge, not a merge.
- **Discipline:** finish one idea completely (excavate → shape → delete) before starting the next, and
  ideally don't run the sweep while mid-build on something else — that context-juggling is the root
  problem this whole flow solves.
- **Delete on convert.** As each idea's task lands, remove that idea's bullet from `.harness/IDEAS.md`.
  The resulting `TASKS.json` task (+ its spec MD) is the record; the inbox stays a clean, transient
  surface. (No "converted" archive — the inbox is gitignored, so there'd be no history of it anyway.)

**Worked example.** Inbox bullet: *"The services page could show each service's daily usage vs its
cap."* → **Phase 1** surfaces: is this a sparkline or a number? daily-only or also monthly? does it
need a new endpoint or is the data already on `GET /api/services/:name`? what's the itch — spotting a
service about to hit its quota? → once understood, **Phase 2** runs add-to-backlog and produces a
`ui`/`component` task scoped to the services page (+ any `api` task if a new field is needed), each
with a real `## Done when`. Then the bullet is deleted from `IDEAS.md`.

> Distribution: the `/idea` + `/convert-ideas` commands are project-local (`.claude/commands/`) for now;
> folding this flow into the distributable `claude-skills` plugin so other projects inherit it is
> tracked by the harness-parity task **T188**.

## The floor (holds even on a direct edit)

If the skill isn't available and you edit `TASKS.json` directly, the non-negotiable invariant is:
**every BUILDABLE task MUST carry `facets: { layer, workType, risk[] }`**, with values chosen ONLY
from `facets.json`'s controlled vocabulary (use the task's `scope` paths to pick the `layer`).
`needs-human` (gated) tasks are **carved out** — they get NO facets. A buildable task missing facets
gets no auto-tuning and the loop **pre-flight WARNs** about it. Background:
`designs/difficulty-autotune.md`.

### UI tasks must get VISUAL confirmation (`facets.layer == ui`)

Structural checks can't see whether a UI element actually RENDERS — T223 shipped a gate padlock that
was present in the DOM but invisible, and passed tsc + tests + the dashboard build + mobile-check. So
for any `layer:ui` task the floor is: **build the dashboard, run `node
dashboard/scripts/visual-check.mjs`, and LOOK at the screenshots** it writes to the gitignored
`dashboard/scripts/visual-out/` — confirm with your own eyes that the change actually paints, and
record what you saw in `.harness/worklog/<TASK>.md`. The loop enforces this mechanically: it injects
the look-at-the-screenshots step into BOTH the builder prompt and the sampled auditor (the auditor
must FAIL if a screenshot contradicts a `## Done when` claim), and it auto-exempts the
`visual-check.mjs` / `_dashboard-harness.mjs` / `mobile-check.mjs` scripts from the scope gate.

**LIVING ARTIFACT.** The page list + fixtures live once in `dashboard/scripts/_dashboard-harness.mjs`.
A UI task that adds a page, adds/removes a workflow or gate, or removes UI **MUST update that file in
the same commit** (its `PAGES` and/or fixtures) so the check stays accurate and doesn't start failing
on intentionally-removed things — same standard as keeping docs current. When AUTHORING a `layer:ui`
task, its `## Done when` MUST include the visual-check line (see the root `CLAUDE.md` rule); the
`convert-ideas` / `ralph-loop-add-to-backlog` flow should inject it for UI tasks.

## Marking a task FAILED (owner correction of a false success)

When the owner judges a `done` task to have actually failed, that is recorded in the owner-owned
`.harness/manual-fail.json` overlay — **never** by hand-editing it, and never by the loop. Use the
`/mark-task-failed` command or `.harness/mark-failed.sh <TNNN> "<reason>"` (the dashboard's "Mark
failed" button writes the same file). The loop READS this overlay to correct calibration — a false
success is re-counted as a failure for difficulty tuning and dropped from its cell's audited-success
count, so that `(layer × workType)` cell is built with a stronger model and audited more often. It
does NOT change task status or re-open the task. Full design: `designs/manual-fail-signal.md`.

## `scope` is the rigour dial — pick its granularity deliberately

A task's `scope` is a **hard boundary**: the loop's `structural_checks` fails any attempt whose diff
touches a file outside it (test files + the task's own worklog are always allowed). It is NOT a
"these files must change" checklist — "did it actually do the work" is the **audit + CI's** job
(`expectsTest: true` is the one cheap positive signal, forcing a test into the diff). `scope`'s only
job is **blast-radius containment**, and its *granularity* is how you express the intended rigour:

- **Greenfield / "this whole area is the blast radius" → scope a DIRECTORY glob**, e.g.
  `src/jobs/tv-recs/**` or `dashboard/app/components/**`. Anything the builder creates *inside that
  tree* — including a proactive new util/helper file it decides it needs — is in-scope and NOT
  punished. Use this for new workflows, new component areas, etc.
- **Surgical / shared / dangerous → pin EXACT files**, e.g. `src/core/executor.ts`,
  `src/db/store.ts`. A new sibling in a shared/core dir then trips scope-creep on purpose, so a
  stronger model (escalation) or a human looks at a high-blast-radius change.

The matcher understands an entry as an **exact path** OR a **directory prefix** — a trailing `/**`,
`/*`, or `/` is stripped to the bare directory, so a file anywhere beneath it counts. (Next.js
bracket dirs like `dashboard/app/workflows/[name]/page.tsx` are matched literally — the brackets are
NOT glob character-classes here.) Rule of thumb: if the task legitimately can't predict every file
(it may refactor or add helpers), scope the **directory**; if it must stay surgical, list the files.

**Always-allowed regardless of scope:** the task's own worklog, **test files** (`*.test.*`/`*.spec.*`/
`tests/…`), and **lockfiles** (`package-lock.json` / `yarn.lock` / `pnpm-lock.yaml`). You therefore do
NOT need to list a lockfile in `scope` — when a task changes dependencies, scoping just `package.json`
is enough; the `npm install`-rewritten `package-lock.json` is auto-allowed (a real dep change still
requires editing `package.json`, which IS scope-checked, so the lockfile can't smuggle anything in).
This auto-exemption was added after a task scoped to `package.json` failed scope-creep on its sibling
`package-lock.json` (T220).

## Known-but-deferred issues (review if they recur)

A running log of harness pathologies we've **seen at least once** and **consciously chose not to fix
yet** — usually because they're rare or only triggered by manual intervention. If you (Claude) hit
one again while working in or evaluating the harness, **flag it to the owner** with a pointer here
rather than silently working around it; a second occurrence is the signal to actually fix it. Add a
dated bullet when you defer something new.

- **2026-06-26 — A manual loop interrupt (Ctrl+C) can orphan a task whose work already merged.**
  *Symptom:* a task's code is on `main` and CI-green, but its `status` is still `pending` (the
  interrupt landed between the push and `mark_done`). The loop then re-selects it, the cold rebuild
  finds the feature already present so it produces only a worklog-only `[skip ci]` commit, and
  `wait_ci_green` never sees a CI run for that SHA → it times out (~`CI_TIMEOUT`s) and treats "no run
  appeared" the SAME as "CI failed" → revert + retry, **forever** (a `…build summary` → `Revert …`
  cycle, climbing the ladder until it falsely BLOCKS a task that's actually done). Two root causes:
  (a) an interrupt can leave a merged task in `pending`; (b) `wait_ci_green` returning *indeterminate*
  (no run / `[skip ci]`) is conflated with *red*. *Manual recovery (what we did):* stop the loop,
  confirm the work is on `main` + green, mark the task `done`, drop the bogus `ci-red` rows from the
  failure buffer, and add a clean `outcomes.jsonl` success row. *Why deferred:* only triggered by a
  manual Ctrl+C mid-task; not worth the complexity yet. *If it recurs:* consider (1) `wait_ci_green`
  treating indeterminate ≠ red, and (2) the loop detecting "this task's work is already on `main` →
  just `mark_done`" instead of rebuilding.
- **2026-06-26 — ROOT CAUSE FOUND + FIXED: `mark_done`/`block_task` silently failed to commit
  `status=done` whenever `failures.jsonl` didn't exist.** The interrupt above was a *red herring* — the
  real reason tasks orphaned was a regression in the T-`failures.jsonl` change (commit `2226eb1`):
  `mark_done` did `git add "$BACKLOG" "$WORKLOG" "$OUTCOMES" "$FAILURES"`, but `.harness/failures.jsonl`
  almost never exists (failures are rare). `git add` fails **atomically** on a missing pathspec —
  staging **nothing** — so `git commit … || true` hit "no changes added to commit" and silently no-op'd.
  The `status=done` therefore lived ONLY as an uncommitted working-tree edit, which the next task's
  `cold_reset` wiped → **every** completed task since `2226eb1` orphaned (T214–T218), not just on
  interrupts (a clean run would orphan them too; the interrupt just made it visible — and the loop log's
  opening `no changes added to commit` line was the smoking gun). *Fix:* stage the always-present files
  first, then add `$FAILURES` only `if [ -f "$FAILURES" ]` (both `mark_done` and `block_task`). Verified
  in a scratch repo: the `mark done` commit now persists with `failures.jsonl` absent. **Do not recombine
  those `git add`s.** The interrupt-window race + `wait_ci_green`-indeterminate items above remain the
  only genuinely-deferred parts.
