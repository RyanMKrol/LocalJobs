---
description: Convert EVERY idea in the inbox into backlog tasks — one agent per idea/cluster, fully parallel, with a single consolidation pass instead of per-agent locking
argument-hint: [optional — a single idea to start with; omit to sweep the whole inbox]
---

Convert ideas from `.harness/IDEAS.md` into well-formed backlog tasks. This is the deliberate Step 2
of the ideas → tasks flow documented in `.harness/CLAUDE.md` § "Ideas inbox & the two-step flow". It
leans on the `ralph-loop-add-to-backlog` schema (task object shape, `## Do`/`## Done when` spec
convention, facets vocabulary) but is NOT that bare skill.

**Model: one agent per idea, or per tightly-related cluster of ideas — fully parallel, no per-agent
locking.** Earlier versions of this skill had every per-idea agent take the shared repo lock itself to
allocate a task id and commit directly to `TASKS.json` — under real concurrent use this caused
task-id collisions, a race where an agent's `IDEAS.md` bullet-removal silently misfired, and forced an
artificial "batch of 4-6" cap purely to keep lock contention manageable. This version removes the
contention by construction instead of just serializing it: **every per-idea agent writes ONLY to its
own uniquely-named scratch file** (no shared resource touched during interview/shaping at all), and a
**single consolidation pass**, run once at the end, allocates every task id, resolves cross-idea
`dependsOn` links, writes `TASKS.json` + spec files, commits, pushes, and cleans up `IDEAS.md` — all in
one locked step instead of one per idea. Because agents no longer contend over anything, **there is no
batch-size cap and no staggering**: launch every independent unit in ONE wave. The only grouping that
still matters is **shared answer-space** — cluster ideas under the SAME agent when answering one idea's
interview question would plausibly change what you'd ask (or how you'd shape) another; see Stage 1.

**Because multiple agents may be asking you things at overlapping times, every question any agent
asks MUST be prefixed with which idea it's about** (a short quoted snippet or title is enough — and if
an agent owns a cluster of several ideas, it must name the SPECIFIC idea within its cluster, not just
the cluster) — this is the one thing that makes concurrent interviews usable instead of confusing.
Bake this into every agent's instructions below; don't skip it.

---

## Stage 0 — recovery check (main thread, serial, before anything else)

Before touching the current inbox, check whether a PREVIOUS sweep was interrupted — this avoids
re-interviewing the owner about work that's already fully decided (or even already committed) because
a prior run never reached its final write.

1. **Leftover pending-task files.** `mkdir -p .harness/.pending-tasks` then
   `ls .harness/.pending-tasks/*.json` (glob may match nothing — that's fine, means no leftovers). Each
   file that exists represents a unit (one idea, or a shared-answer-space cluster) that was FULLY
   interviewed and shaped in a prior run but never consolidated — the run ended before Stage 3 (a
   crash, a Ctrl+C, the owner closing the session) ran. If any exist, **run Stage 3 on them right now**,
   before doing anything else — this flushes the backlog into real tasks so today's sweep starts clean
   and nobody has to re-answer already-settled questions.

2. **Stale `IDEAS.md` bullets for already-converted ideas.** Some interruptions land between "task
   committed" and "bullet removed" (observed live in a real sweep — a task landed cleanly but its
   source bullet stayed in the inbox because the removal step never ran). Before interviewing anyone,
   do a lightweight, fuzzy cross-check: skim `git log --oneline -15` for recent `backlog: add …`
   commits and `.harness/TASKS.json`'s most recent ~10 entries' titles. For any CURRENT inbox bullet
   that plausibly matches one of those — same file/component/feature — surface it to the owner via
   `AskUserQuestion`: *"This bullet looks like it might already be covered by `<task id/title>` —
   already done, or still wanted?"* Only remove the bullet (no new task) if the owner confirms; this
   check is fuzzy and judgment-based, so never silently drop a bullet without asking.

---

## Stage 1 — build the worklist, de-dup, group by shared answer-space (main thread, serial)

Read `.harness/IDEAS.md`'s `## Inbox` (after Stage 0's flush/cleanup). Collect every remaining bullet
into a worklist. If the inbox is empty, say so and stop. If the owner is clearly mid-build on something
else, say so and offer to defer the whole sweep.

**De-dup pass.** Scan the full worklist for ideas that are the same idea or substantially overlap —
SEMANTIC similarity, not exact-text match. Group suspected duplicates and surface each group to the
owner via `AskUserQuestion`: present the overlapping bullets, explain why you think they're the same,
ask whether to merge or drop one. Do NOT auto-merge.

**Grouping pass — replaces the old "relation pass."** Look at the whole remaining worklist for two
distinct kinds of relationship, and treat them differently:

- **Shared answer-space → put them on the SAME agent.** Two (or more) ideas share answer-space when
  the answer to one idea's interview question would plausibly change what you'd ask — or how you'd
  shape — another idea. Concrete signals: both ideas touch the same page/component/file and a design
  choice in one determines what "done" means for the other; the idea text itself cross-references
  another idea explicitly (e.g. "discuss this together with…"); one idea is really a refinement or
  qualification of another's scope. Judgment call — ask yourself "if I answered idea A's questions
  first, would that change any question I'd ask for idea B?" If yes, assign ONE agent the whole
  cluster, to interview end-to-end (it may interleave questions across the cluster's ideas in whatever
  order makes sense, always naming which specific idea a given question is about).
- **Hard dependency, but NO shared answer-space → still SEPARATE agents, launched in the SAME wave.**
  One idea is a foundation the other builds on (needs its eventual task id in `dependsOn`), but the
  dependent's own shaping doesn't depend on the foundation's answers — it just needs a reference to
  resolve later. Thanks to Stage 2's tempId scheme, these no longer need to be staggered: tell both
  agents each other's assigned slug/tempId at launch, and Stage 3's consolidation resolves the real
  link once both are known. Note the pair, but do not delay either agent's launch.
- **Genuinely orthogonal → separate agents, no relationship at all.** Everything else. Do NOT group
  these down for the sake of a smaller batch — there is no lock contention to protect against anymore,
  and conservative batching wastes the owner's time for no benefit.

Whatever remains after de-dup is the set of **agent units** (a unit = one idea, or a shared-answer-space
cluster) that proceeds to Stage 2 — every unit launches together, in one wave.

---

## Stage 2 — parallel per-unit agents (explore → interview loop → shape → OWN scratch file only)

**Launch every agent unit from Stage 1 together, in ONE message (all `Agent` tool calls at once).**
There is no batch cap and no staggering for any reason — including hard-dependency pairs (tell both
agents in that pair the other's slug so they can cross-reference; do not launch one after the other).

**Each per-unit agent gets this brief** (fresh agent, full tool access — it needs `AskUserQuestion`,
`Read`/`Grep`/`Glob`/`Bash` for exploration, and `Write` for its own scratch file — it does NOT need
`Edit`, and never touches `.harness/TASKS.json`, `.harness/tasks/`, `.harness/IDEAS.md`, or git):

> You are converting ONE idea — or a small cluster of tightly-related ideas, if you were told you own
> more than one — from the owner's backlog inbox into task data. Work through these phases yourself,
> end to end. Nobody else is doing any part of this for you, and nobody is waiting for you before
> doing their own idea (other agents are converting other ideas concurrently right now), so take the
> time you actually need. You are NOT racing anyone for a shared resource — you only ever write to
> your own uniquely-named file, so there is nothing to contend over.
>
> **The idea(s) (verbatim):** `<idea bullet text — or N bullet texts if you own a cluster>`
>
> **(If you own a cluster) why these are grouped:** `<one line explaining the shared answer-space —
> so you understand why you own more than one idea>`
>
> **(If flagged) hard-dependency partner:** `<another unit's slug, if Stage 1 flagged a foundation/
> dependent relationship with a concurrently-running unit — use this slug in your dependsOn, see below>`
>
> **1. Explore.** Read root `CLAUDE.md`, `.harness/HARNESS.md` §8.1 (task schema), `.harness/facets.json`
> (facet vocabulary), and whatever source/dashboard paths the idea text(s) anchor to. Work out the
> likely itch/problem, feasibility, relevant files, and a first-pass decomposition.
>
> **2. Interview — loop until YOU are genuinely satisfied, not for a fixed number of rounds.** Ask the
> owner via `AskUserQuestion` (batch up to 4 questions per call) to settle: what they actually want
> (don't assume anything is fleshed out), the decomposition (one task or several — see the atomise
> rule below), `scope`, `design`, `verify`, `facets` (`layer`/`workType`/`risk`, from `facets.json`'s
> controlled vocabulary), `gate` (`null`/`"gate"`/`"needs-human"`, including the chooser/review/
> hardcode three-task pattern from `.harness/CLAUDE.md` when the idea offers multiple options to pick
> between), and `dependsOn`. If an answer opens a new question, ask another round — there's no cap,
> just make sure each round is asking something new. **Every question you ask must open by naming the
> specific idea it's about** (e.g. "For the idea about <short summary>: …") so the owner can tell your
> questions apart from another agent's questions arriving at the same time — including other ideas
> inside your OWN cluster, if you own more than one.
>
> **If your interview concludes no task is actually warranted** (a pure check-in idea that resolves to
> "already fine, no change needed"): don't invent a trivial task just to have one. Leave `tasks: []` in
> your pending file (below) but still record the idea's bullet text and a `report` explaining the
> resolution — the consolidation step still removes your idea's bullet from `IDEAS.md` even with zero
> tasks.
>
> **Atomise (non-negotiable).** A task is too big when it spans multiple layers (`db`+`core`+`ui`),
> carries broad/full-stack `risk` flags, or has a multi-part `## Done when` with independent acceptance
> criteria. Split into the smallest self-contained, separately-verifiable units.
>
> **Cross-referencing another unit's task.** If your idea has a hard dependency on another idea being
> converted in this same sweep, reference it by the **tempId** you were given for it (e.g.
> `"needs-hardcode-theme-1"`) in your task's `dependsOn` — NOT a real task id, which doesn't exist yet.
> If your OWN exploration surfaces a dependency nobody flagged at launch, ask the owner about it; if
> you can't confirm the other unit's slug, just name the relationship in your `report` so the
> consolidation step (or the owner) can wire it up by hand.
>
> **3. Once satisfied, shape your task(s) and write ONE local file — no lock, no git, no `TASKS.json`
> edit.** Pick a short kebab-case slug for your unit (e.g. `hardcode-theme`, `services-categorization`)
> and use the `Write` tool to create `.harness/.pending-tasks/<slug>.json`:
> ```jsonc
> {
>   "agentSlug": "<slug>",
>   "ideaBullets": ["<verbatim idea text 1>", "<verbatim idea text 2, if a cluster>"],
>   "tasks": [
>     {
>       "tempId": "<slug>-1",
>       "title": "<concise title>",
>       "dependsOn": ["<other-slug>-1", "T292"],
>       "gate": null,
>       "tags": ["<type>"],
>       "facets": { "layer": "...", "workType": "...", "risk": [] },
>       "scope": ["<files/globs>"],
>       "design": null,
>       "verify": [],
>       "expectsTest": false,
>       "specDo": "<the '## Do' body text, self-contained for a FRESH builder agent with none of this\n conversation's context: no ambiguous referents like \"the ID\"/\"the page\", cite concrete\n anchors like path/file.ts:NNN where known>",
>       "specDoneWhen": "<the '## Done when' body text, concrete and runnable where possible>"
>     }
>   ],
>   "report": "<your understanding, facet mismatches, unresolved cross-unit references, anything the\n            owner should know>"
> }
> ```
> `needs-human`/gated tasks omit `facets`. Any task with `facets.layer == "ui"` MUST have a
> `specDoneWhen` that requires: build the dashboard, run `node dashboard/scripts/visual-check.mjs`,
> look at the screenshots, confirm the specific thing renders — and if the change only appears after
> an interaction (modal/expand/click), also require adding/updating a `FLOWS` entry in
> `dashboard/scripts/_dashboard-harness.mjs`. **Do NOT touch `.harness/IDEAS.md`, `.harness/TASKS.json`,
> `.harness/tasks/`, or git** — the consolidation step does all of that in one pass, once, for every
> unit, at the end. Just write your one JSON file and stop.
>
> **4. Report back**: your understanding, the slug you used, any facet mismatches (append to
> `facet-misfits.jsonl` per its format if truly nothing in `facets.json` fits), any cross-unit
> references you made or couldn't resolve, and confirmation your pending file was written.

---

## Stage 3 — ONE consolidation pass (main thread, after every launched unit reports back)

Once every unit from the current wave has reported done, run consolidation YOURSELF — not a subagent.
This step is now mostly mechanical (id allocation + file writes + one commit), and doing it directly
avoids spawning an agent just to hold a lock for a few seconds. (Stage 0 may also invoke this exact
procedure early, on leftover files, before Stage 1 even runs.)

⚠️ **Environment note:** in this environment the Bash tool's interactive shell is `zsh`, but
`.harness/repo-lock.sh` relies on bash-only `${BASH_SOURCE[0]}` and only derives its lock path
correctly when actually executed BY bash. **Always write the critical section below to a temp `.sh`
file (e.g. via the `Write` tool) and run it with `bash /path/to/script.sh`** — never `source
.harness/repo-lock.sh` directly in a Bash tool call here; sourcing it under zsh silently corrupts the
derived lock path and produces garbled `git`/`cd` errors.

```bash
#!/usr/bin/env bash
set -euo pipefail
source .harness/repo-lock.sh
acquire_lock || exit 1
trap release_lock EXIT
# --- everything below runs while holding the lock — NOTHING collidable is decided before this line ---
# 1. Re-read TASKS.json NOW, fresh from disk — compute the starting id from the CURRENT highest id,
#    zero-padded to the same width. This is the ONLY place in the whole sweep an id is ever chosen,
#    so there is nothing left to collide over.
# 2. Read every .harness/.pending-tasks/*.json file. For each task across every file (stable order,
#    e.g. sorted by agentSlug then array index), allocate the next sequential id. Build a
#    tempId -> realId lookup as you go.
# 3. Resolve every task's dependsOn: a real existing "Txxx" id passes through unchanged; a tempId
#    reference resolves via the lookup from step 2; a tempId with no match (its unit produced no
#    task, e.g. "no action needed") is DROPPED and noted for the final report so the owner can wire
#    it up by hand if still wanted.
# 4. Write .harness/tasks/TNNN.md for every task (from its specDo/specDoneWhen strings) — skip this
#    entirely for units whose "tasks" array is empty (a resolved "no action needed" idea).
# 5. Build the full new-tasks array (real ids + resolved dependsOn) into new-tasks.json, then:
#      jq --slurpfile add new-tasks.json '.tasks += $add[0]' .harness/TASKS.json > TASKS.json.tmp \
#        && jq empty TASKS.json.tmp && mv TASKS.json.tmp .harness/TASKS.json
# 6. Remove every consumed idea's bullet(s) from .harness/IDEAS.md — re-read IDEAS.md fresh, RIGHT
#    NOW under the lock (never from an earlier snapshot), and remove each one by exact text match
#    using the "ideaBullets" arrays recorded in the pending files (including for empty-tasks units —
#    their bullet is removed too, since their idea WAS resolved, just with no task). If a bullet's
#    exact text is no longer present (already removed some other way), skip it rather than erroring —
#    this is the only bullet-removal step in the whole flow, so there is no race to guard against, but
#    a defensive skip costs nothing.
# 7. git add ONLY .harness/TASKS.json + the new .harness/tasks/TNNN.md file(s). NEVER git add -A/.,
#    NEVER stage IDEAS.md (gitignored), .harness/.pending-tasks/ (scratch, gitignored), data/, .env*,
#    credentials.
# 8. git commit (heredoc message enumerating every new task id, e.g. "backlog: add T304-T310 from
#    idea conversion sweep"), then git push. On rejection: git fetch origin && git rebase origin/main,
#    retry once; if it still fails, report it — the commit is safe locally either way.
# 9. Delete every .harness/.pending-tasks/*.json file consumed in this pass — their content is now
#    durably represented by the git commit, so nothing is lost by removing the scratch copy.
release_lock
```

If a straggler unit reports back AFTER you've already run consolidation, just run Stage 3 again for
it alone — it's cheap and idempotent (it only ever processes whatever `.pending-tasks/*.json` files
still exist on disk).

---

## Stage 4 — final validation + report (main thread)

Do ONE check yourself (not a subagent):

- `jq empty .harness/TASKS.json` — still valid JSON.
- No duplicate ids, every `dependsOn` id exists, no cycles.
- Every buildable task has a `facets` object with values from `facets.json`'s vocabulary; needs-human
  tasks have none.
- Every task's `spec` path has a matching file on disk.
- `.harness/.pending-tasks/` is empty (or contains only units from a wave still in flight, if you're
  checking mid-sweep).
- `.harness/IDEAS.md` — confirm every converted idea's bullet is gone (including "no action needed"
  resolutions) and every un-converted one (dropped in de-dup, or deferred) is still present.

Report a short summary across the whole sweep: each idea → the task id(s) it became (or "no action
needed"), any de-dup merges/drops, any dropped/unresolved cross-idea `dependsOn` the owner should link
manually, and confirmation the inbox and pending-tasks scratch dir are left correctly. Both
`.harness/IDEAS.md` and `.harness/.pending-tasks/` are gitignored — never commit either. Everything
else was committed + pushed inside Stage 3's single consolidation pass, so there's nothing left to
commit unless that step reported a failed push (retry it here if so).
