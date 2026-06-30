---
description: Convert EVERY idea in the inbox into backlog tasks — a per-idea two-phase interview, looped
argument-hint: [optional — a single idea to start with; omit to sweep the whole inbox]
---

Convert ideas from `.harness/IDEAS.md` into well-formed backlog tasks. This is the deliberate Step 2
of the ideas → tasks flow documented in `.harness/CLAUDE.md` § "Ideas inbox & the two-step flow". It
is NOT the bare `ralph-loop-add-to-backlog` skill — it adds an excavation phase in front of it, and
it sweeps the **whole inbox** in one invocation, handling each idea one-by-one.

This is a **workflow**: it walks every idea in the inbox, converting them one at a time, until the
inbox is empty. The batch is the only thing that changed from the old one-per-invocation command —
each idea STILL gets its own full excavation. Never shape several ideas at once; the per-idea
excavation is the whole point of this flow.

Process:

0. **Read the inbox / build the worklist.**  Read `.harness/IDEAS.md`'s `## Inbox`. Collect every
   bullet into a worklist. If `$ARGUMENTS` names a specific idea, start with that one (but still
   continue through the rest afterwards unless told otherwise). If the inbox is empty, say so and stop.
   If the owner is clearly mid-build on something else, say so and offer to defer the whole sweep.

   **De-dup pass (run before converting anything).** Scan the full worklist for ideas that are the
   **same idea or substantially overlap** — use SEMANTIC similarity, not just exact-text match (the
   same idea often appears in different words). Group any suspected duplicates and **surface each
   duplicate group to the owner via `AskUserQuestion`** — present the overlapping bullets, explain
   why you think they're the same, and ask whether to merge them into one or drop one. Do NOT
   auto-merge silently; the owner decides.

   This is distinct from the **related-ideas → `dependsOn`** handling in Phase 2: two ideas that are
   *related but distinct* (one a foundation the other builds on) become a `dependsOn` edge and are
   NOT merged — the de-dup pass targets genuine **duplicates** (the same idea appearing twice). Only
   merge/drop when the ideas describe the *same underlying change*; otherwise proceed to the normal
   per-idea loop below.

1. **Loop — for EACH idea in the worklist, one at a time:**

   a. **Phase 1 — idea excavation (the part add-to-backlog lacks).** Treat the idea as barely formed
      — often one vague sentence. Before any task-shaping, probe the owner with clarifying questions
      to surface what it ACTUALLY is: the underlying itch/problem, what they're really after, the
      rough shape, and why it matters. Default to MORE questions here; assume nothing is fleshed out.
      Use AskUserQuestion. Do not proceed to shaping until THIS idea is genuinely understood.

   b. **Phase 2 — task shaping.** Hand the now-understood idea to the **`ralph-loop-add-to-backlog`**
      skill (invoke it, seeding it with the excavated understanding). Let it run its interview (DoD,
      scope, dependsOn, facets, spec MD) and append the schema-correct task(s) to `TASKS.json`. If
      two ideas are clearly related (e.g. one is a foundation the other builds on), encode that as a
      `dependsOn` edge rather than merging them.
      - **Atomise — size every task to ONE cold builder attempt (sizing gate, non-negotiable).**
        Before shaping, decompose the idea so each resulting task is completable by a single cold pass
        in a reasonable time/context budget — and SPLIT anything that isn't. A task is too big when it
        spans multiple layers (e.g. `db` + `core` + `ui`), carries broad/full-stack `risk` flags, or
        has a multi-part `## Done when` with several independent acceptance criteria. **Empirical
        tell:** an attempt that runs 25–30+ minutes or repeatedly fails the cold tier is almost always
        under-atomised — e.g. T258 (a status-model change spanning `store.ts` + `workflow-executor.ts`
        + places stages + the dashboard) took ~25–30 min PER attempt and kept failing the DoD. Split
        such an idea into a **dependency chain** of the smallest self-contained, separately verifiable
        units — typically **backend logic + its tests FIRST**, then a **dependent UI-surfacing task**,
        then any cross-cutting follow-up — each with its own tight `scope`, `facets`, and runnable
        `## Done when`. Prefer several small tasks over one big one: the loop builds, verifies, and
        commits each independently, so smaller tasks finish faster, fail more cheaply, and escalate
        more precisely. (Same decomposition discipline as add-to-backlog §2.2 + the sizing pushback in
        §6 — enforce it here too, on every idea.)
      - **For a `facets.layer == ui` task, the `## Done when` MUST include the visual-confirmation
        line** (alongside the existing mobile-check line), e.g.:
        > `node dashboard/scripts/visual-check.mjs` was run after `npm --prefix dashboard run build`,
        > the screenshots in `dashboard/scripts/visual-out/` confirm <the thing this task makes
        > visible> renders, and `dashboard/scripts/_dashboard-harness.mjs` (`PAGES`/fixtures/`FLOWS`)
        > is updated if the UI surface changed.
        - **If the thing the task makes visible only appears after an INTERACTION** (an opened
          modal/popover, an expanded section, a clicked control, a multi-step flow), the `## Done when`
          MUST ALSO require adding/updating a **`FLOWS`** entry in `_dashboard-harness.mjs` (with
          `viewport: true` for modal/overlay states) so a screenshot captures that interacted state —
          a baseline `PAGES` shot can't show what you have to click to reveal. Name the specific flow
          in the done-when (e.g. "a `FLOWS` entry opens the Consumers modal and its screenshot shows …").

        This mirrors the LIVING ARTIFACT rule in the root + `.harness/CLAUDE.md`: a UI task that adds a
        page / adds or removes a workflow or gate / removes UI / adds an interactive state must keep the
        shared harness (`PAGES` + fixtures + `FLOWS`) current.

   c. **Delete on convert.** Once this idea's task(s) land, REMOVE its bullet from `.harness/IDEAS.md`
      (the resulting TASKS.json task is now the record). Leave the rest of the inbox untouched, then
      move to the next idea.

2. **Between ideas, keep context clean.** Finish one idea completely (excavate → shape → delete)
   before starting the next. Don't juggle several half-shaped ideas at once — convert sequentially.

3. Report: a short summary listing each idea converted, the task id(s) it became, and confirm every
   converted bullet was removed from the inbox. `.harness/IDEAS.md` is gitignored — do not commit it;
   commit the `TASKS.json` + `tasks/TNNN.md` changes the add-to-backlog skill produced (and push, per
   repo rules). A single commit covering the whole sweep is fine, or one per idea — your call.
