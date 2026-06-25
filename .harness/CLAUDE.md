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
