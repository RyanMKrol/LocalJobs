---
description: Investigate every failed/blocked backlog task (owner manual-fail + loop give-up) and author better-specified follow-up tasks
argument-hint: (optional) a task id to focus on, e.g. T278 — omit for a full sweep of every failed/blocked task
---

Review backlog tasks the harness could NOT complete — either the **owner** overturned a false success
(`status="failed"`, via the manual-fail overlay) or the **loop itself** gave up (`status="blocked"`,
via `block_task()`) — and turn what went wrong into a genuinely better-specified follow-up task, not
just a blind retry of the same spec. This is a **deliberate, human-invoked review**, not something the
loop runs on its own; nothing in the schedule/run path ever calls this.

Focus target: `$ARGUMENTS` (if a task id is given, review just that one task; if empty, sweep every
task currently `status="failed"` or `status="blocked"`).

**Why both statuses, not just `failed`:** `status="failed"` and `status="blocked"` are the two
DIFFERENT ways a task ends up needing a human's attention (see root `CLAUDE.md`'s "Marking a task
FAILED"/blocked sections and `.harness/CLAUDE.md`'s matching sections) — `failed` is the OWNER
retroactively correcting a false success (a `manual-fail.json` overlay entry with a `reason`);
`blocked` is the LOOP's own give-up signal (an agent-reported blocker, or `MAX_ATTEMPTS` exhausted at
the top model tier — a worklog `failed:blocked` marker + `outcomes.jsonl`/`failures.jsonl` rows). Both
are genuinely `TASKS.json`-queryable by `status` (the `blocked` status write is a recent addition —
before it, a loop give-up was only a worklog text marker, invisible outside raw log reading). Both are
**terminal** — the loop will never re-select or re-open either on its own — so a human review is the
ONLY path back to progress on that work.

This command **leans on the exact same pending-tasks/consolidation mechanism as
`/local-jobs-convert-ideas`** (see `.harness/CLAUDE.md` § "Ideas inbox & the two-step flow" for the
underlying design) rather than inventing a new one: each per-task review agent writes ONLY to its own
uniquely-named `.harness/.pending-tasks/<slug>.json` + spec `.md` file(s), and
`.harness/scripts/consolidate-ideas.sh` (unchanged, reused verbatim) does the id allocation,
`dependsOn` resolution, `TASKS.json` merge, and the single commit+push at the end. **This command does
NOT touch `.harness/tracking/IDEAS.md`** — it has nothing to do with the ideas inbox; only the
pending-tasks/pending-questions scratch dirs and `TASKS.json` are involved.

⚠️ **`AskUserQuestion` is main-thread-only, exactly as in `/local-jobs-convert-ideas`.** A per-task
review agent has no way to block on a live prompt — a genuine open question goes through the SAME
durable-file relay: `.harness/.pending-questions/<slug>.json`, batched by the coordinator via
`AskUserQuestion`, answers relayed back via `SendMessage`. Every question must open by naming which
failed/blocked task it's about (several agents may be investigating concurrently).

---

## Stage 0 — recovery check (main thread, serial, before anything else)

Exactly like `/local-jobs-convert-ideas`'s Stage 0 — a prior review sweep may have been interrupted
before it finished:

1. `mkdir -p .harness/.pending-tasks .harness/.pending-questions`, then `ls .harness/.pending-tasks/*.json`
   — if any exist, run Stage 3 (consolidation) on them right now, before touching anything new.
2. `ls .harness/.pending-questions/*.json` — if any exist, relay their `questions` to the owner via
   `AskUserQuestion` (same per-task-prefixed batching), then launch a fresh agent per unit seeded with
   the file's content + the owner's answers, instruct it to finish and write its pending-tasks file (or
   confirm it's stopping with nothing to write), delete the old pending-questions file. Run Stage 3
   again once every leftover is resolved.

---

## Stage 1 — build the worklist (main thread, serial)

```bash
# every currently failed/blocked task, or just the focus task if $ARGUMENTS names one
jq -r '.tasks[]|select(.status=="failed" or .status=="blocked")|.id' .harness/tracking/TASKS.json
```

If `$ARGUMENTS` names a task id, confirm it's actually `failed` or `blocked` (if it's some other
status, tell the owner this command only reviews failed/blocked tasks and stop). If the worklist is
empty, say so and stop — nothing to review.

**No de-dup pass is needed here** (unlike `/local-jobs-convert-ideas` — each failed/blocked task is
already a distinct, unique input, not a raw idea that might overlap another). **No grouping pass
either** — a failed/blocked task's review is self-contained to its own history; two failed tasks
sharing a root cause (e.g. the same scope-gate bug tripped two different tasks) is possible but rare
enough not to warrant the added complexity of clustering, and an agent that notices this during its
own investigation can say so in its `report` for the owner to connect by hand.

Every task in the worklist gets its own review agent, launched together in ONE wave (same
no-batch-cap, no-staggering rationale as convert-ideas — agents only ever write their own file, so
there is nothing to contend over).

---

## Stage 2 — parallel per-task review agents (investigate → optionally interview → shape → OWN scratch file only)

**Each review agent gets this brief** (fresh agent, full tool access for `Read`/`Grep`/`Glob`/`Bash`
exploration + `Write` for its own scratch file; it does NOT have `AskUserQuestion`; it never touches
`.harness/tracking/TASKS.json`, `.harness/tasks/`, `.harness/tracking/IDEAS.md`, or git):

> You are reviewing ONE failed/blocked backlog task in the `local-jobs` repo (task id: `<TNNN>`,
> `status: "<failed|blocked>"`) to understand what went wrong and, if warranted, author a
> better-specified follow-up task. Nobody else is doing this task's review for you; other agents are
> reviewing OTHER failed/blocked tasks concurrently right now.
>
> **1. Gather every piece of evidence about what happened — do not guess.**
> - The original task definition: `jq '.tasks[]|select(.id=="<TNNN>")' .harness/tracking/TASKS.json`
>   (title, scope, facets, dependsOn, gate) and its spec `.harness/tasks/<TNNN>.md` (`## Overview`/
>   `## Do`/`## Done when` — note the task may predate the `## Overview` convention, that's fine).
> - **If `status=="failed"`** (owner manual-fail): read `.harness/tracking/manual-fail.json`'s entry
>   for this id — the `reason` field is the owner's own words for why the recorded success was wrong.
>   This is usually the SINGLE most important piece of evidence; take it at face value, don't second-guess it.
> - **If `status=="blocked"`** (loop gave up): read `.harness/worklog/<TNNN>.md` in full (the
>   `failed:blocked <TNNN> — <reason>` marker plus everything the builder/auditor agents narrated during
>   every attempt — this is usually rich), and every `.harness/ledgers/failures.jsonl` row for this id
>   (`jq -c 'select(.id=="<TNNN>")' .harness/ledgers/failures.jsonl` — the FULL escalation history: what
>   failed at each rung, and whether the causes were all the same kind or genuinely different), and the
>   `.harness/ledgers/outcomes.jsonl` row (`jq -c 'select(.id=="<TNNN>")' .harness/ledgers/outcomes.jsonl`
>   — `topRung`/`totalSoftFails`/the terminal `reason`). If `.harness/worklog/<TNNN>.audit.md` exists,
>   read it too (a blocking-audit FAIL is a distinct, richer failure mode from a scope/CI failure —
>   understand what the auditor specifically flagged).
> - **Check whether this is even still relevant.** Read the CURRENT state of whatever the task's
>   `scope` touches — has something else already fixed the underlying problem since this task failed
>   (a later, unrelated task, or manual work)? Grep recent `git log` for the scope paths. If the problem
>   is genuinely already resolved, this review concludes **no follow-up needed** (see step 3).
>
> **2. Form a genuine understanding of the ROOT CAUSE, not just the proximate failure.** A `blocked`
> task's proximate cause is often mechanical (scope-creep, a missing doc in scope, CI red, exhausted
> attempts) — the useful question is WHY: was the original task's `scope` too narrow for what the
> `## Done when` actually required (the most common real cause per prior incidents in this repo — see
> e.g. T322's and T342's own worklogs for worked examples of exactly this pattern)? Was the spec itself
> ambiguous or under-specified? Did the task depend on something that wasn't actually ready? Was it
> just genuinely hard and the model needed to escalate further than `MAX_ATTEMPTS` allowed? A `failed`
> task's owner `reason` may point at a subtler issue — e.g. an audit that passed but shouldn't have, a
> `## Done when` that was met technically but missed the actual intent. Whatever you conclude, your
> follow-up task's spec must be **demonstrably better** than the original at the SPECIFIC thing that
> went wrong — a straight retry with the identical spec would just fail the same way again.
>
> **3. Decide: no follow-up needed, needs owner input, or ready to shape.**
> - **No follow-up needed** (problem already resolved elsewhere, or the failure was a stale/invalid
>   signal — e.g. a framework bug since fixed, not a real defect in the task): write
>   `.harness/.pending-tasks/<slug>.json` with `tasks: []` and a `report` explaining the resolution — no
>   spec files needed. (There is no `IDEAS.md` bullet to remove here, unlike convert-ideas — this step
>   just means "nothing further to author.")
> - **Genuine open question the owner should answer** before a follow-up can be shaped confidently
>   (e.g. the failure suggests the original ask itself was ambiguous, or a real product/design decision
>   is needed, not just a scope/spec fix): write `.harness/.pending-questions/<slug>.json` (schema:
>   `{agentSlug, ideaBullets: ["<TNNN>: <original title>"], questions, report}` — reusing the exact
>   convert-ideas schema; `ideaBullets` here is just the reviewed task's id+title for context, not a
>   real idea bullet), question(s) prefixed "For the review of <TNNN> (<original title>): ...". Do NOT
>   shape a task yet; wait for the coordinator's follow-up message with the owner's answer.
> - **Confident enough to shape directly** (the root cause and the fix are clear from the evidence
>   alone): proceed to step 4.
>
> **4. Shape the follow-up task and write your local files — no lock, no git, no `TASKS.json` edit.**
> Pick a slug (e.g. `review-t278`, or `review-t278-cluster` if one review genuinely produces more than
> one follow-up task). Write the spec as a REAL markdown file, `.harness/.pending-tasks/<tempId>.md`,
> with the standard `## Overview` / `## Do` / `## Done when` sections — the SAME convention
> `/local-jobs-convert-ideas` uses (see `.harness/CLAUDE.md`). Two things specific to a review-derived
> task:
> - **`## Overview` should name what this is a re-attempt of and why the first attempt didn't land** —
>   e.g. "Re-attempt of T278 (blocked: scope excluded a required client helper) — this time the scope
>   includes both the server endpoint and its dashboard client wrapper." One or two sentences, same bar
>   as every other Overview.
> - **`## Do` must incorporate the actual lesson**, not just restate the original spec — if the cause
>   was scope-too-narrow, the new `scope` must genuinely cover what's needed (verify this yourself by
>   reading the `## Done when` requirements against the proposed scope, don't just assume); if the cause
>   was an ambiguous requirement, resolve the ambiguity explicitly in the new spec's text; if the cause
>   was genuine difficulty, consider whether `facets`/an explicit starting tier hint or a smaller,
>   further-atomised task is warranted this time.
> Then write `.harness/.pending-tasks/<slug>.json` referencing the spec file(s), using the EXACT same
> JSON shape `/local-jobs-convert-ideas` uses (`agentSlug`, `tasks: [{tempId, title, dependsOn, gate,
> tags, facets, scope, design, verify, expectsTest, specFile}]`, `report`) — set `ideaBullets` to
> `["<TNNN>: <original title>"]` (review agents have no real idea bullet; this keeps the schema
> byte-compatible with what `consolidate-ideas.mjs` already parses, so no script change is needed).
> **Do NOT set `dependsOn` to the original failed/blocked task** — it's terminal, nothing should wait on
> it; the traceability lives in the new task's `## Overview` prose instead. Atomise per the usual rule
> if the review surfaces more than one genuinely separable follow-up.
>
> **5. Report back**: your understanding of the root cause, which of the three step-3 outcomes you
> reached, the slug you used, and confirmation of what you wrote (or didn't).

---

## Stage 3 — ONE consolidation pass (main thread, after every launched agent reports back)

**Reuse `/local-jobs-convert-ideas`'s Stage 3 verbatim — run `bash .harness/scripts/consolidate-ideas.sh`.**
No new script is needed: this command's pending-tasks files are byte-compatible with what
`consolidate-ideas.mjs` already reads (same JSON shape, same `specFile` convention). The ONE
behavioral difference to be aware of: `consolidate-ideas.mjs` also tries to remove a matching bullet
from `.harness/tracking/IDEAS.md` for each consumed unit — since a review agent's `ideaBullets` is a
synthetic `"<TNNN>: <title>"` string that will never fuzzy-match anything real in `IDEAS.md`, the
script will log a harmless `no bullet match` warning per unit consolidated by this command. **This is
expected and NOT a problem to fix** — it is not a real miss, just a log line; do not go "clean up" a
phantom bullet in `IDEAS.md` because of it.

```bash
bash .harness/scripts/consolidate-ideas.sh
```

`NO_PUSH=1 bash .harness/scripts/consolidate-ideas.sh` to commit locally only. Idempotent — safe to
re-run if a straggler agent reports back late.

---

## Stage 4 — final validation + report (main thread)

Same checks as `/local-jobs-convert-ideas` Stage 4: `jq empty .harness/tracking/TASKS.json`, no
duplicate ids, every `dependsOn` id exists, every buildable task has `facets` from the controlled
vocabulary, every task's `spec` path has a matching file, `.pending-tasks/`/`.pending-questions/` both
empty (or only mid-sweep stragglers).

Report a short summary across the whole review sweep: each reviewed task id → its outcome (a new
follow-up task id, "no follow-up needed" + why, or a question relayed to the owner and its answer),
and confirmation the pending-tasks/pending-questions scratch dirs are left correctly. **The reviewed
tasks themselves stay `status="failed"`/`status="blocked"` — this command never changes that status**
(they're terminal by design; a new task is how progress resumes, not a reopen).

If the sweep produced ≥1 new task, close by suggesting `/local-jobs-pre-loop-checkin` before the next
unattended run, same as convert-ideas.
