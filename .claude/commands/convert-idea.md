---
description: Convert ONE idea from the inbox into a backlog task via a two-phase interview
argument-hint: [optional — which idea to convert; omit to be shown the inbox and pick]
---

Convert a single idea from `.harness/IDEAS.md` into a well-formed backlog task. This is the
deliberate Step 2 of the ideas → tasks flow documented in `.harness/CLAUDE.md` § "Ideas inbox & the
two-step flow". It is NOT the bare `ralph-loop-add-to-backlog` skill — it adds an excavation phase in
front of it.

Process:

0. **Pick ONE idea.** Read `.harness/IDEAS.md`'s `## Inbox`. If `$ARGUMENTS` names/points at an idea,
   use it; otherwise list the inbox bullets and ask the owner which ONE to convert. Convert exactly
   one per invocation. If the owner is clearly mid-build on something else, say so and offer to defer
   — the point of this flow is to avoid context-juggling.

1. **Phase 1 — idea excavation (the part add-to-backlog lacks).** Treat the idea as barely formed —
   often one vague sentence. Before any task-shaping, probe the owner with clarifying questions to
   surface what it ACTUALLY is: the underlying itch/problem, what they're really after, the rough
   shape, and why it matters. Default to MORE questions here; assume nothing is fleshed out. Use
   AskUserQuestion. Do not proceed until the idea is genuinely understood.

2. **Phase 2 — task shaping.** Hand the now-understood idea to the **`ralph-loop-add-to-backlog`**
   skill (invoke it, seeding it with the excavated understanding). Let it run its interview (DoD,
   scope, dependsOn, facets, spec MD) and append the schema-correct task(s) to `TASKS.json`.

3. **Delete on convert.** Once the task(s) land, REMOVE the converted bullet from `.harness/IDEAS.md`
   (the resulting TASKS.json task is now the record). Leave the rest of the inbox untouched.

4. Report: which idea was converted, the task id(s) it became, and that the bullet was removed from
   the inbox. `.harness/IDEAS.md` is gitignored — do not commit it; commit the `TASKS.json` +
   `tasks/TNNN.md` changes the add-to-backlog skill produced (and push, per repo rules).
