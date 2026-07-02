---
description: Convert EVERY idea in the inbox into backlog tasks — one independent agent per idea, running in parallel
argument-hint: [optional — a single idea to start with; omit to sweep the whole inbox]
---

Convert ideas from `.harness/IDEAS.md` into well-formed backlog tasks. This is the deliberate Step 2
of the ideas → tasks flow documented in `.harness/CLAUDE.md` § "Ideas inbox & the two-step flow". It
leans on the `ralph-loop-add-to-backlog` schema (task object shape, `## Do`/`## Done when` spec
convention, facets vocabulary) but is NOT that bare skill.

**Model: one independent agent per idea, running the whole thing end-to-end, in parallel.** The old
approach converted ideas one at a time — think, ask, think more, shape, write — fully serially. That
wastes the owner's time: an idea that only needed one quick answer had to wait behind one that needed
five. Instead, each idea gets its OWN agent that owns its entire lifecycle: explore → interview (as
many rounds as IT needs, not a fixed count) → shape → write, under a shared lock for the write step.
All these agents launch together and run independently. If idea A's agent is satisfied after one
round of questions, it goes straight to shaping and committing in the background while idea B's agent
is still on its third round of follow-ups — nobody waits on anybody else except at the shared lock,
and that's only held for the few seconds it takes to append a task and commit.

**Because multiple agents may be asking you things at overlapping times, every question any agent
asks MUST be prefixed with which idea it's about** (a short quoted snippet or title is enough) — this
is the one thing that makes concurrent interviews usable instead of confusing. Bake this into every
agent's instructions below; don't skip it.

---

## Stage 0 — build the worklist, de-dup, spot cross-idea dependencies (main thread, serial)

Read `.harness/IDEAS.md`'s `## Inbox`. Collect every bullet into a worklist. If the inbox is empty,
say so and stop. If the owner is clearly mid-build on something else, say so and offer to defer the
whole sweep.

**De-dup pass.** Scan the full worklist for ideas that are the same idea or substantially overlap —
SEMANTIC similarity, not exact-text match. Group suspected duplicates and surface each group to the
owner via `AskUserQuestion`: present the overlapping bullets, explain why you think they're the same,
ask whether to merge or drop one. Do NOT auto-merge.

**Relation pass.** While you're looking at the whole worklist anyway, flag any pair where one idea
is clearly a *foundation* the other *builds on* (not a duplicate — genuinely sequential work). Note
these pairs; they change how you batch Stage 1 below.

Whatever remains after de-dup is the worklist that proceeds to Stage 1.

---

## Stage 1 — parallel per-idea agents (explore → interview loop → shape → locked write)

**Batching.** Ideas with no relation to each other launch together, in a single message (multiple
`Agent` tool calls at once) — that's what makes them genuinely concurrent. For a pair flagged as
foundation→dependent in Stage 0, launch the foundation idea's agent first, let it finish completely
(so its real task id exists in `TASKS.json`), THEN launch the dependent idea's agent with that id
available to put in `dependsOn`. Everything else fans out together. If `$ARGUMENTS` names a specific
idea, no special ordering is needed for it (it's not "first" in any meaningful sense anymore — there's
no serial interview queue) — just include it in the appropriate batch. If the worklist is unusually
large, keep any one batch to roughly 4-6 concurrently-interviewing agents so your questions don't get
too interleaved to follow; queue the rest into a following batch.

**Each per-idea agent gets this brief** (fresh agent, full tool access — it needs `AskUserQuestion`,
`Read`/`Grep`/`Glob`/`Bash`, and `Write`/`Edit`):

> You are converting ONE idea from the owner's backlog inbox into TASKS.json task(s). Work through
> these phases yourself, end to end — nobody else is doing any part of this for you, and nobody is
> waiting for you before doing their own idea, so take the time you actually need.
>
> **The idea (verbatim):** `<idea bullet text>`
>
> **1. Explore.** Read root `CLAUDE.md`, `.harness/HARNESS.md` §8.1 (task schema), `.harness/facets.json`
> (facet vocabulary), and whatever source/dashboard paths the idea text anchors to. Work out the likely
> itch/problem, feasibility, relevant files, and a first-pass decomposition.
>
> **2. Interview — loop until YOU are genuinely satisfied, not for a fixed number of rounds.** Ask the
> owner via `AskUserQuestion` (batch up to 4 questions per call) to settle: what they actually want
> (don't assume anything is fleshed out), the decomposition (one task or several — see the atomise
> rule below), `scope`, `design`, `verify`, `facets` (`layer`/`workType`/`risk`, from `facets.json`'s
> controlled vocabulary), `gate` (`null`/`"gate"`/`"needs-human"`, including the chooser/review/
> hardcode three-task pattern from `.harness/CLAUDE.md` when the idea offers multiple options to pick
> between), and `dependsOn`. If an answer opens a new question, ask another round — there's no cap,
> just make sure each round is asking something new, not re-litigating an answered point. **Every
> question you ask must open by naming this idea** (e.g. "For the idea about <short summary>: …") so
> the owner can tell your questions apart from another idea's agent asking at the same time.
>
> **Atomise (non-negotiable).** A task is too big when it spans multiple layers (`db`+`core`+`ui`),
> carries broad/full-stack `risk` flags, or has a multi-part `## Done when` with independent
> acceptance criteria. Split into the smallest self-contained, separately-verifiable units — typically
> backend logic+tests first, then a dependent UI-surfacing task, then any cross-cutting follow-up.
>
> **If your exploration surfaces a relationship to ANOTHER idea currently being converted** (not
> flagged for you already) that you can't resolve yourself: ask the owner about it, and if the other
> idea's task doesn't exist yet in `TASKS.json` by the time you're ready to write, don't block waiting
> for it — write your task without that `dependsOn` link and say so clearly in your final report so the
> owner can add the edge manually.
>
> **3. Once satisfied, shape + write — the ENTIRE critical section as ONE bash script in ONE Bash tool
> call.** Acquire and release must happen in the same live shell process — see
> `.harness/repo-lock.sh`'s header comment for why (the stale-lock reclaim is PID-liveness based, so
> splitting this across multiple Bash calls makes the lock meaningless):
> ```bash
> source .harness/repo-lock.sh
> acquire_lock || exit 1
> trap release_lock EXIT
> # --- everything below runs while holding the lock ---
> # 1. Re-read TASKS.json NOW (another idea's agent may have appended while you were interviewing) —
> #    compute the next id(s) from the CURRENT highest id, zero-padded to the same width.
> # 2. Write .harness/tasks/TNNN.md for each new task: `## Do` (1-3 sentences, self-contained — the
> #    eventual builder is a FRESH agent with none of this conversation's context: no ambiguous
> #    referents like "the ID"/"the page", cite concrete anchors like path/file.ts:NNN where known)
> #    and `## Done when` (concrete, runnable where possible; for UI/behavioural tasks require
> #    verification against the real running thing, not just build/tests-pass).
> # 3. Build the new task object(s) (schema below) into new-tasks.json, then:
> #      jq --slurpfile add new-tasks.json '.tasks += $add[0]' .harness/TASKS.json > TASKS.json.tmp \
> #        && jq empty TASKS.json.tmp && mv TASKS.json.tmp .harness/TASKS.json
> # 4. Remove ONLY this idea's bullet from .harness/IDEAS.md.
> # 5. git add ONLY the specific files you touched: .harness/TASKS.json + the new tasks/TNNN.md
> #    file(s). NEVER `git add -A`/`.`, NEVER stage IDEAS.md (gitignored), data/, .env*, credentials.
> # 6. git commit (heredoc message, e.g. "backlog: add TNNN <title> (from idea)"), then git push.
> #    On push rejection: git fetch origin && git rebase origin/main, retry once; if it still fails,
> #    say so in your report but don't treat it as a failure — the commit is safe locally.
> release_lock   # trap also covers this, but call it explicitly for a clean early exit too
> ```
> Task object schema (per `HARNESS.md` §8.1 — re-read it live, this is a reference copy):
> ```jsonc
> {
>   "id": "TNNN", "title": "<concise title>", "status": "pending", "dependsOn": ["<ids>"],
>   "gate": null, "tags": ["<type>"], "facets": { "layer": "...", "workType": "...", "risk": [] },
>   "scope": ["<files/globs>"], "design": null, "verify": [], "expectsTest": false,
>   "spec": ".harness/tasks/TNNN.md"
> }
> ```
> Ids monotonic from the current max (re-read under the lock, not from memory). `status` always
> `"pending"`. `needs-human`/gated tasks omit `facets`. Any task with `facets.layer == "ui"` MUST have
> a `## Done when` that requires: build the dashboard, run `node dashboard/scripts/visual-check.mjs`,
> look at the screenshots, confirm the specific thing renders — and if the change only appears after
> an interaction (modal/expand/click), also require adding/updating a `FLOWS` entry in
> `dashboard/scripts/_dashboard-harness.mjs`.
>
> **4. Report back**: your understanding of the idea, the task id(s) you created, any facet mismatches
> (append to `facet-misfits.jsonl` per its format if truly nothing in `facets.json` fits), any
> cross-idea `dependsOn` you couldn't resolve, and any push retry.

Launch the current batch's agents together (one message, N `Agent` calls). Because each agent's
critical section is a single locked script, concurrent writers naturally queue for their turn on the
lock rather than racing — an agent that finishes its interview early is never blocked by one still
mid-conversation with you.

---

## Stage 2 — report + final validation (main thread, after each batch returns)

Once a batch's agents have all reported back, do ONE check yourself (not a subagent):

- `jq empty .harness/TASKS.json` — still valid JSON.
- No duplicate ids, every `dependsOn` id exists, no cycles.
- Every buildable task has a `facets` object with values from `facets.json`'s vocabulary; needs-human
  tasks have none.
- Every task's `spec` path has a matching file on disk.
- `.harness/IDEAS.md` — confirm every converted idea's bullet is gone and every un-converted one
  (dropped in de-dup, or deferred) is still present.

Then move to the next batch (if any), and finally report a short summary across the whole sweep: each
idea → the task id(s) it became, any de-dup merges/drops, any unresolved cross-idea `dependsOn` the
owner should link manually, and confirmation the inbox is left correctly. `.harness/IDEAS.md` is
gitignored — never commit it. `TASKS.json` + `tasks/TNNN.md` changes were already committed + pushed
per-idea inside each agent's locked critical section, so there's nothing left to commit unless an
agent reported a failed push (retry it here if so).
