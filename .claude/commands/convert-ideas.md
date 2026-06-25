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

0. **Read the inbox.** Read `.harness/IDEAS.md`'s `## Inbox`. Collect every bullet into a worklist.
   If `$ARGUMENTS` names a specific idea, start with that one (but still continue through the rest
   afterwards unless told otherwise). If the inbox is empty, say so and stop. If the owner is clearly
   mid-build on something else, say so and offer to defer the whole sweep.

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

   c. **Delete on convert.** Once this idea's task(s) land, REMOVE its bullet from `.harness/IDEAS.md`
      (the resulting TASKS.json task is now the record). Leave the rest of the inbox untouched, then
      move to the next idea.

2. **Between ideas, keep context clean.** Finish one idea completely (excavate → shape → delete)
   before starting the next. Don't juggle several half-shaped ideas at once — convert sequentially.

3. Report: a short summary listing each idea converted, the task id(s) it became, and confirm every
   converted bullet was removed from the inbox. `.harness/IDEAS.md` is gitignored — do not commit it;
   commit the `TASKS.json` + `tasks/TNNN.md` changes the add-to-backlog skill produced (and push, per
   repo rules). A single commit covering the whole sweep is fine, or one per idea — your call.
