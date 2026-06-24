# Difficulty auto-tuning — design

The harness builds each task with an AI agent at a chosen **difficulty** (which model + reasoning
effort to try first). Historically that difficulty was a one-shot guess set by whoever (or whatever
LLM) authored the task — miscalibrated, with no feedback. This system replaces the guess with a
**self-tuning policy** that learns, per *kind* of task, the cheapest setting that reliably works —
saving cost and improving first-try success, with the human out of the loop.

## The closed loop (one line)

> **backlog → loop builds on an escalating ladder → capture each outcome → calibrate by facet →
> policy picks the cheapest-safe starting tier → repeat, getting cheaper + better-calibrated.**

The key asymmetry that makes it work: **starting too cheap is self-correcting and self-teaching**
(the task escalates, you recover via the ladder, and you learn the class is harder than thought),
while **starting too expensive is silent waste** (it succeeds, but you never learn a cheaper tier
would have worked). So the policy **biases toward cheap and leans on the ladder as the safety net** —
that simultaneously saves money *and* generates the data to keep learning.

---

## 1. Facets — the vocabulary (the join key)

A **facet** is one labelled axis describing a task. We describe each buildable task along a few
*independent, difficulty-predictive* axes — not a freeform tag bag (which fragments the data):

- **`layer`** (exactly one) — *where* the change lives. Project-specific; largely inferable from the
  task's scope file paths. (local-jobs: `ui`, `dashboard-logic`, `api`, `job`, `service`,
  `framework`, `db`, `harness`.)
- **`work-type`** (exactly one) — *what kind* of change. Largely **universal** across projects.
  (`style`, `logging`, `docs`, `config`, `component`, `endpoint`, `bugfix`, `feature`, `migration`,
  `llm-prompt`, `refactor`.)
- **`risk`** (zero or more) — danger modifiers, each pushes difficulty up. (`touches-schema`,
  `touches-executor`, `full-stack`, `cross-cutting`.)

The **calibration keys on `layer × work-type`**; `risk` refines once a cell is dense. Feature-area
labels (movies/plex/…) stay descriptive only — they don't predict difficulty.

**Source of truth: `.harness/facets.json`** — declares the controlled vocabulary (+ definitions +
difficulty hints), the global tier ladder, and the policy knobs. Three consumers read it: authoring
(picks values from it), calibration/policy (validate + know the cell space), and a human (curates).

**`needs-human` tasks are carved out entirely** — they never run through the loop, so they get no
facets, no difficulty, and never enter calibration.

---

## 2. The global difficulty ladder

`facets.json → .tiers.ladder`: an ordered list of `{model, effort}` tiers, cheapest → priciest. There
is ONE global ladder (not per-task escalation arrays). The policy picks a **start tier** per task;
escalation walks **up** the ladder from there (clamped at the top). The authored model/effort is only
the **cold-start prior**. local-jobs' ladder (7 tiers):
`sonnet/low · sonnet/medium · sonnet/high · opus/medium · opus/high · opus/xhigh · opus/max`.

`MAX_ATTEMPTS` soft failures per tier before escalating (now **2**, because the ladder is fine-grained
— fewer tries per tier keeps the total attempt budget bounded).

---

## 3. Capture — the ledger  *(BUILT)*

`loop.sh`'s `mark_done`/`block_task` append one JSON row per built task to **`.harness/outcomes.jsonl`**:
`{ id, ts, facets, scopeSize, startModel/Effort, finalModel/Effort, succeededRung, topRung,
attemptsAtRung, totalSoftFails, blocked, reason }`.

- **Forward-only by construction:** only tasks the loop actually builds reach `mark_done`/`block_task`,
  so gated/needs-human tasks write nothing.
- **The ledger is the SOLE input to calibration.** Re-tagging done tasks (which have no ledger rows)
  can never influence the policy — the calibration joins *from* ledger rows to their facets, never
  *from* the task list. This is the invariant that lets us retro-tag for completeness with zero
  effect on forward decisions.

---

## 4. Calibration + policy — the decision  *(BUILT)*

`.harness/policy.jq` reads the ledger and, for a task's `(layer × work-type)` cell, expands each row
into per-tier pass/fail events (every tier from start up to the success tier failed; the success tier
passed; a blocked row failed at every tier it reached), then returns:

> the **cheapest tier** whose historical first-attempt success rate for that cell is **≥ floor (0.75)**
> with **≥ minN (6)** samples; otherwise the **authored difficulty** (cold-start prior).

`loop.sh`'s `pick_base` runs it at task selection; the rung machinery rides the global ladder offset
by that base (`cur_base`). Validated across cold-start, no-blind-downgrade, upgrade-on-escalation,
minN/floor guards, and discovered-downgrade. Robust: missing facets / empty ledger / any error → the
prior, so it can never break the loop.

---

## 5. Authoring — assigning facets + the poor-fit signal  *(TO BUILD — add-to-backlog skill)*

When a new task is authored (the add-to-backlog flow), the LLM assigns the facets — it **describes**
the task, it no longer **guesses the difficulty** (the policy decides that). Rules:

1. **Always fit the existing vocabulary first.** Pick `layer` (use the scope file paths as the primary
   signal) + `work-type` from `facets.json`; add `risk` flags. This is a small fixed menu — far more
   consistent than freeform.
2. **Never silently invent a value.** If the LLM is genuinely confident nothing fits, it does NOT mint
   a new value (that re-fragments the calibration into sparse cells). Instead it records a
   **poor-fit signal** with context: `{ taskId, axis: "layer"|"work-type", closest: <best existing
   value>, note: "<one line: what was missing>", ts }`, appended to **`.harness/facet-misfits.jsonl`**,
   and tags the task with `closest` so it's still bucketed somewhere usable.

Poor-fit is overwhelmingly a **`layer`** problem (layers are project-specific and the project's
structure evolves); `work-type` is universal and rarely misfits.

---

## 6. Layer evolution — the poor-fit gate  *(TO BUILD — add-to-backlog skill)*

The vocabulary must evolve **without a human babysitting it** — the harness is *most* productive early
in a project, exactly when structure is least defined and layers are fuzziest, so poor-fit signals
accumulate fastest when the vocabulary is least mature. The mechanism self-front-loads: it fires early
and often as structure emerges, then goes quiet as it stabilises.

**The gate (inside the add-to-backlog flow):** when a task is being added, if the accumulated poor-fit
count ≥ a threshold **N**, trigger a **layer re-evaluation** before continuing:

1. **Re-cluster (LLM-driven):** an agent reads the recent backlog + the poor-fit signals + the current
   `layer` set and proposes an updated set (add / split / merge / rename), exactly like the initial
   per-project layer derivation.
2. **Surface it to the human — with teaching, not just a diff.** The person adding the task may not
   even know this difficulty/escalation machinery exists. So the prompt MUST open with a short
   plain-language paragraph explaining what the harness does and what they're deciding, *then* show the
   proposed change. Template:

   > *"Heads up: this project's build harness automatically decides how much AI effort (which model +
   > reasoning level) to spend on each task, and learns from results — it starts cheap, escalates only
   > when a task fails, and remembers which kinds of work need more power. It groups tasks by 'layer'
   > (roughly, where in the codebase the work lives) to make those predictions. We've now seen **N**
   > recent tasks that didn't fit any existing layer well, which usually means the project has grown
   > past its current layer list. Here's a proposed updated set: `<diff>`. Approving it re-groups
   > recent work so the harness keeps predicting difficulty accurately. It's optional and reversible —
   > declining just keeps the current layers."*

   The human **approves / nudges / declines** — they never do the clustering themselves.
3. **Migrate history (the real cost — don't skip).** Changing layers shifts the *calibration cells*.
   On accept, the re-eval MUST remap the existing `outcomes.jsonl` rows' facets **and** re-tag the
   tasks to the new layer values — otherwise the changed cells silently **cold-start from zero** and
   the policy goes briefly blind there. A split (`ui → ui-view/ui-state`) needs the old `ui` rows
   reassigned; a rename is a straight substitution; a merge is a union. Update `facets.json` (the
   vocabulary) in the same step.
4. **Cooldown:** clear the poor-fit counter after a re-eval so it doesn't re-fire on every subsequent
   task once over threshold.

Scope: this is a **`layer`**-evolution mechanism. New **values** within an axis evolve this way; new
**axes** (a 4th facet) are rare and stay a deliberate, explicit change.

---

## 7. Portability — works on any project out of the box  *(TO BUILD — plugin)*

The faceting *framework* (layer × work-type × risk + the ladder + capture + calibration + policy + the
evolution gate) is **fully universal** and lives in the plugin. Only the **values** differ per project:

- **`work-type`** ships as a strong universal default (rarely changed).
- **`layer`** ships as a generic starter set (`frontend`/`backend`/`data`/`infra`/`build`/`meta`), and
  the **create-harness step inspects the new repo's structure and proposes a tailored `layer` set**
  written into that project's `facets.json` (the same clustering the evolution gate uses, run once at
  setup). Universal out of the box, auto-fitted at setup, then self-evolving via §6.
- The **global tier ladder** is project-specific (its models) and lives in each project's `facets.json`.

---

## 8. Status + tunables

| Piece | State |
|---|---|
| Faceted taxonomy + `facets.json` (vocabulary, ladder, knobs) | ✅ built |
| Retro-tags on 170 buildable tasks; needs-human carved out | ✅ built |
| Capture (`outcomes.jsonl` from mark_done/block_task) | ✅ built |
| Calibration + policy (`policy.jq`, rung machinery on the global ladder) | ✅ built |
| `MAX_ATTEMPTS` = 2 | ✅ built |
| Authoring: assign facets + emit poor-fit (add-to-backlog skill) | ⬜ to build |
| Poor-fit gate + layer re-eval + history migration + human prompt | ⬜ to build |
| Portability: plugin framework + per-project layer setup | ⬜ to build (plugin) |
| Surface calibration (a dashboard "harness health" view) | ⬜ optional |

**Tunables:** `floor` (0.75) and `minN` (6) in `facets.json`; `MAX_ATTEMPTS` (2) in `loop.sh`; the
poor-fit threshold **N** (to be set). **Possible future:** explicit downward *exploration* (occasionally
start one tier below the policy's pick to probe for cheaper settings) — today downward discovery relies
on the cheapest-qualifying rule + the authoring side trying cheaper.

**Invariant to preserve forever:** the calibration aggregates **only from `outcomes.jsonl`**, joining
each ledger row → its facets → its cell. It must never derive an outcome from a task's status or
authored difficulty. That is what keeps retro-tagged/done tasks (and any future metadata edit) from
ever leaking into difficulty selection.
