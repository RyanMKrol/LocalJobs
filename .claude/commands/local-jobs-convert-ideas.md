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

⚠️ **`AskUserQuestion` is NOT available to Stage 2 agents — it is main-thread/interactive-only.**
Agents launched via the `Agent` tool run as background subagents; they have no way to block on a live
interactive prompt, so a per-unit agent that tries to call `AskUserQuestion` will find it missing from
its tool list (confirmed via `ToolSearch` in practice — don't make agents waste a call rediscovering
this each sweep; the brief below tells them directly). **Questions are relayed through YOU (the main
thread), not asked directly by the subagent.**

**Don't rely on your own conversation memory to carry open questions — that's a dropped-question risk
(long-sweep context pressure, a summarization event, or the session ending mid-relay all lose it).**
An agent with a genuine open question writes it to a **durable file**,
`.harness/.pending-questions/<slug>.json` (schema below), as well as putting it in its final report
text — the file is the authoritative record; the report text is just for your immediate visibility.
This mirrors why completed units write `.harness/.pending-tasks/<slug>.json` instead of you just
remembering their shape: anything that must survive an interruption goes on disk, not in memory.

The actual flow, once every Stage 2 agent reports back:
1. An agent that reached a genuine open question (not something it could reasonably decide itself)
   writes `.harness/.pending-questions/<slug>.json` (see schema in the agent brief below), does NOT
   write its pending-tasks file, and puts the same question(s) in its final report text — still
   prefixed per-idea as above.
2. An agent that could make a confident, low-risk, well-documented judgment call instead of blocking
   (e.g. reusing an existing styling convention already used elsewhere in the same file) SHOULD do
   that and write its pending-tasks file directly, recording the judgment call in its `report` field
   for the owner to override later if needed — don't manufacture a question just because the tool is
   missing.
3. Once you've heard back from every launched unit, run `ls .harness/.pending-questions/*.json` and
   read each file — **this is the authoritative list of open questions, not your recollection of report
   texts.** Collect every question across every file and relay them to the owner via `AskUserQuestion`,
   batching up to 4 questions per call (several calls in sequence if there are more) — keep each
   question's per-idea prefix from the file.
4. For every unit that's still blocked, `SendMessage` its `agentId` with the owner's answers relevant
   to that unit (only that unit's, not everyone else's). **Don't assume the answers fully unblock it** —
   tell the agent explicitly to check: if the answers settle everything, delete its own
   `.harness/.pending-questions/<slug>.json` and finish shaping + write its pending-tasks file; if the
   answers open a genuinely NEW question, it should instead **overwrite**
   `.harness/.pending-questions/<slug>.json` with the new question(s) (same schema, same file — not a
   second file) and report back still-blocked, same as its first round. Loop steps 3-4 again for any
   unit that comes back still-blocked — there's no cap on rounds, only on asking something it could
   have decided itself.
5. Only proceed to Stage 3 once every launched unit has EITHER written a pending-tasks file OR (for a
   genuinely deferred idea — see the interview step below) explicitly confirmed it's writing none, AND
   `.harness/.pending-questions/` is empty — an unexpected leftover file at this point means a unit
   came back still-blocked and got missed in a relay round; check for it before declaring the sweep done.

**Crash/interruption recovery for open questions is Stage 0's job** (see its new step below) — if the
whole sweep dies while units are blocked, the durable `.pending-questions/*.json` files are exactly
what lets a FUTURE sweep pick the thread back up instead of silently losing it.

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

2. **Leftover pending-QUESTION files.** `mkdir -p .harness/.pending-questions` then
   `ls .harness/.pending-questions/*.json`. Each file represents a unit that was blocked on a genuine
   open question when a PRIOR sweep ended before the question was ever relayed to the owner (a crash,
   a Ctrl+C, or the session ending mid-relay — see the warning above `## Stage 2`). Don't silently drop
   these — the idea's bullet is still sitting in `IDEAS.md` waiting on an answer nobody gave. For each
   file: read it (schema: `{ agentSlug, ideaBullets, questions, report }`), relay its `questions` to the
   owner via `AskUserQuestion` (same per-idea-prefixed batching as a live sweep), then launch a FRESH
   agent for that unit — you do not need (and should not assume) the original agent is still resumable
   across a new session — seeded with the pending-questions file's full content (idea bullets, what a
   prior agent already worked out, the questions it asked) plus the owner's answers, and instruct it to
   pick up from there: finish shaping, write `.harness/.pending-tasks/<slug>.json`, and delete the old
   `.harness/.pending-questions/<slug>.json`. Once every leftover question file is resolved this way,
   run Stage 3 to flush the resulting pending-tasks files before continuing to Stage 1 — this ensures
   Stage 1 reads an `IDEAS.md` that no longer carries bullets for already-resolved ideas.

3. **Stale `IDEAS.md` bullets for already-converted ideas.** Some interruptions land between "task
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

**Each per-unit agent gets this brief** (fresh agent, full tool access — it needs `Read`/`Grep`/`Glob`/
`Bash` for exploration and `Write` for its own scratch file — it does NOT have `AskUserQuestion` (main-
thread-only, see the warning above — tell the agent this directly so it doesn't waste a `ToolSearch`
call finding out), does NOT need `Edit`, and never touches `.harness/TASKS.json`, `.harness/tasks/`,
`.harness/IDEAS.md`, or git):

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
> **1. Explore.** Read root `CLAUDE.md`, `.harness/docs/HARNESS.md` §8.1 (task schema), `.harness/config/facets.json`
> (facet vocabulary), and whatever source/dashboard paths the idea text(s) anchor to. Work out the
> likely itch/problem, feasibility, relevant files, and a first-pass decomposition.
>
> **2. Interview — settle what you can yourself; surface only genuine open questions.** You do **NOT**
> have `AskUserQuestion` — it's not in your tool list (main-thread/interactive-only), so don't try it
> or spend a `ToolSearch` call confirming that. Work out from your exploration + judgment: what the
> owner actually wants (don't assume anything is fleshed out), the decomposition (one task or several —
> see the atomise rule below), `scope`, `design`, `verify`, `facets` (`layer`/`workType`/`risk`, from
> `facets.json`'s controlled vocabulary), `gate` (`null`/`"gate"`/`"needs-human"`, including the
> chooser/review/hardcode three-task pattern from `.harness/CLAUDE.md` when the idea offers multiple
> options to pick between), and `dependsOn`.
>
> For anything you can decide with reasonable confidence — a low-risk styling choice, reusing a
> convention already established elsewhere in the file, an unambiguous reading of the idea text — just
> decide it and note the judgment call in your final `report`; don't manufacture a question for
> something you could reasonably call yourself. Reserve actual questions for things that are genuinely
> ambiguous, consequential, or risky (multiple real interpretations that would produce meaningfully
> different tasks; a decision the owner clearly needs to make, like whether to take on new risk).
>
> **If you have genuine open questions, do NOT write your pending-tasks file yet.** Instead, use the
> `Write` tool to create `.harness/.pending-questions/<slug>.json` — this is the DURABLE record of what
> you're blocked on (don't rely on your report text alone reaching the coordinator; the file survives
> even if the coordinator's session ends before it relays your question):
> ```jsonc
> {
>   "agentSlug": "<slug>",
>   "ideaBullets": ["<verbatim idea text 1>", "<verbatim idea text 2, if a cluster>"],
>   "questions": ["<question 1, opening with which idea it's about>", "<question 2>"],
>   "report": "<what you've worked out so far, so a fresh agent could pick this up without re-exploring>"
> }
> ```
> Then ALSO put the same questions in your final report text (for the coordinator's immediate
> visibility) — **every question must open by naming the specific idea it's about** (e.g. "For the idea
> about <short summary>: …"), same rule as always. The coordinator will batch your questions with
> everyone else's, get them answered by the owner, and send you a follow-up message with the answers
> relevant to your unit.
>
> **When you get that follow-up message, check whether the answers actually settle everything before
> you proceed** — don't assume one round is always enough:
> - If yes, **delete `.harness/.pending-questions/<slug>.json`** and finish shaping + write your
>   pending-tasks file (below).
> - If the answers open a genuinely NEW question you couldn't have decided yourself, **overwrite**
>   `.harness/.pending-questions/<slug>.json` with the new question(s) (same file, same schema — don't
>   leave the old, now-answered questions in it) and end your turn again with the new question(s) in
>   your report, exactly as the first round. There's no cap on rounds — just don't re-ask anything the
>   answers already covered, and don't manufacture a question you could reasonably decide yourself.
>
> **If your interview concludes no task is actually warranted** (a pure check-in idea that resolves to
> "already fine, no change needed"): don't invent a trivial task just to have one. Leave `tasks: []` in
> your pending file (below) but still record the idea's bullet text and a `report` explaining the
> resolution — the consolidation step still removes your idea's bullet from `IDEAS.md` even with zero
> tasks.
>
> **If the owner's answer is to defer/decline the idea entirely** (see the risk-decision case in the
> worked example below): delete `.harness/.pending-questions/<slug>.json` if you wrote one, and don't
> write a pending-tasks file at all — writing one (even with `tasks: []`) tells the consolidation pass
> the idea is "resolved" and removes its bullet from `IDEAS.md`, which is wrong for a genuine deferral.
> Just confirm in your final report that you're stopping with no files left behind, so the bullet stays
> in the inbox for a future sweep.
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
> **3. Once satisfied, shape your task(s) and write your local files — no lock, no git, no `TASKS.json`
> edit.** Pick a short kebab-case slug for your unit (e.g. `hardcode-theme`, `services-categorization`).
>
> **Write the spec as a REAL markdown file per task FIRST — not as a JSON string field.** For every
> task, use the `Write` tool to create `.harness/.pending-tasks/<tempId>.md` (e.g.
> `hardcode-theme-1.md`) containing the actual `## Do` / `## Done when` spec, written as genuine
> markdown:
> ```markdown
> ## Do
>
> <self-contained for a FRESH builder agent with none of this conversation's context: no ambiguous
> referents like "the ID"/"the page", cite concrete anchors like path/file.ts:NNN where known. Use
> real markdown — headers, code fences, nested lists, tables, whatever the content actually calls
> for. This is the builder's ENTIRE brief; don't compress it to fit a flat string.>
>
> ## Done when
>
> <concrete, runnable where possible. Same rule — use real markdown structure (a numbered checklist
> of acceptance criteria often reads far better here than a single paragraph).>
> ```
> This is deliberate: `specDo`/`specDoneWhen` as JSON string fields (the old shape of this schema)
> forced you to author a two-section markdown document through JSON-string escaping — every quote,
> backtick fence, and newline had to survive being embedded in a string literal, which both risks
> silent corruption and subtly discourages writing the richly-structured spec a real task deserves.
> Writing the actual `.md` file removes that friction entirely: be as expressive as the task needs.
>
> **Then write ONE local JSON file** — `.harness/.pending-tasks/<slug>.json` — referencing each task's
> spec file by name (not its content):
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
>       "specFile": "<tempId>.md"
>     }
>   ],
>   "report": "<your understanding, facet mismatches, unresolved cross-unit references, anything the\n            owner should know>"
> }
> ```
> `specFile` is just the bare filename — it lives alongside this JSON file in the same
> `.harness/.pending-tasks/` directory, so the consolidation pass can find it without needing a full
> path. `needs-human`/gated tasks omit `facets` but still get a `specFile` — everyone gets a real spec.
> Any task with `facets.layer == "ui"` MUST have its `## Done when` require: build the dashboard, run
> `node dashboard/scripts/visual-check.mjs`, look at the screenshots, confirm the specific thing
> renders — and if the change only appears after an interaction (modal/expand/click), also require
> adding/updating a `FLOWS` entry in `dashboard/scripts/_dashboard-harness.mjs`. **Do NOT touch
> `.harness/IDEAS.md`, `.harness/TASKS.json`, `.harness/tasks/`, or git** — the consolidation step does
> all of that in one pass, once, for every unit, at the end. Just write your `.md` file(s) + one JSON
> file and stop.
>
> **4. Report back**: your understanding, the slug you used, any facet mismatches (append to
> `facet-misfits.jsonl` per its format if truly nothing in `facets.json` fits), any cross-unit
> references you made or couldn't resolve, and confirmation your pending file was written.

---

## Stage 3 — ONE consolidation pass (main thread, after every launched unit reports back)

Once every unit from the current wave has reported done, run **`.harness/scripts/consolidate-ideas.sh`** —
a permanent, tested framework script (paired with `.harness/scripts/consolidate-ideas.mjs`), not something
to re-derive from pseudocode each sweep:

```bash
bash .harness/scripts/consolidate-ideas.sh
```

Run it directly with `bash` — do not `source` it, and do not invoke it under a non-bash interactive
shell (this environment's Bash tool shell is `zsh`; the script's shebang + explicit `bash` invocation
sidesteps that, but don't second-guess it by sourcing `repo-lock.sh` yourself in a raw Bash call).

**What it does** (id allocation + file writes + one commit — see the header comments in both files
for the full mechanics): re-reads `TASKS.json` fresh under the shared repo lock and computes the next
sequential id from the current highest; reads every `.harness/.pending-tasks/*.json` file (stable
order) and allocates each task a real id, building a `tempId -> realId` map as it goes; resolves every
task's `dependsOn` (a real existing `Txxx` id passes through unchanged, a `tempId` resolves via the
map, an unresolvable `tempId` — e.g. its unit produced zero tasks — is dropped and reported); writes
`.harness/tasks/TNNN.md` for every task by **reading its referenced `specFile` and copying that
markdown content verbatim** (not reconstructing it from JSON string fields — there's nothing to
reconstruct, the real spec content already exists as a file; skipped for empty-`tasks` units, and the
script errors loudly if a task's `specFile` is missing or unreadable rather than silently writing an
empty spec); merges the new tasks into `TASKS.json`; removes every consumed idea's bullet from
`IDEAS.md` via **fuzzy match** (normalized: backticks stripped, whitespace collapsed — a pending
file's recorded `ideaBullets` text is a reflowed paragraph, so it won't byte-match the hand-line-wrapped
markdown; exact match would silently fail to remove anything); `git add`s ONLY `TASKS.json` + the new
`tasks/TNNN.md` files (never `-A`/`.`, never stages `IDEAS.md` or `.pending-tasks/`, both gitignored);
commits with an auto-generated message enumerating the new task ids, then pushes (fetch+rebase+retry
on rejection); deletes the consumed pending files — both the unit's `.json` file AND every per-task
`.md` spec file it referenced.

A unit that was **deliberately deferred** (owner declined mid-interview — see the `plex-file-naming`
worked example) writes no pending file at all, so it's correctly invisible to this pass: no task, no
bullet removal, the idea stays in the inbox untouched for a future sweep.

Read the script's own stdout (it prints a full summary: allocated ids, any dropped `dependsOn`, bullet
match/no-match per unit) — a `no bullet match` warning means a bullet was left in `IDEAS.md` despite
its idea being converted, and needs manual cleanup or a closer look at why the fuzzy match missed it.

Offline / don't want to push yet: `NO_PUSH=1 bash .harness/scripts/consolidate-ideas.sh` (commits locally only).

If a straggler unit reports back AFTER you've already run consolidation, just run
`bash .harness/scripts/consolidate-ideas.sh` again — it's idempotent, and only ever processes whatever
`.pending-tasks/*.json` files still exist on disk (running it with an empty pending dir is a no-op:
it prints "nothing to consolidate" and exits 0). Stage 0 also invokes this exact script on any
leftover files from a prior interrupted sweep, before Stage 1 even runs.

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
- `.harness/.pending-questions/` is empty (or contains only units genuinely still waiting on an owner
  answer, if you're checking mid-sweep) — a leftover file here after the sweep is declared done means a
  question was never relayed; go relay it rather than leaving it to silently rot until the next sweep's
  Stage 0 happens to find it.
- `.harness/IDEAS.md` — confirm every converted idea's bullet is gone (including "no action needed"
  resolutions) and every un-converted one (dropped in de-dup, or deferred) is still present.

Report a short summary across the whole sweep: each idea → the task id(s) it became (or "no action
needed"), any de-dup merges/drops, any dropped/unresolved cross-idea `dependsOn` the owner should link
manually, and confirmation the inbox and pending-tasks/pending-questions scratch dirs are left
correctly. `.harness/IDEAS.md`, `.harness/.pending-tasks/`, and `.harness/.pending-questions/` are all
gitignored — never commit any of them. Everything else was committed + pushed inside Stage 3's single
consolidation pass, so there's nothing left to commit unless that step reported a failed push (retry it
here if so).

**If the sweep produced ≥1 new task, close your report by suggesting the owner run
`/local-jobs-pre-loop-checkin` before starting an unattended run.** Freshly-authored tasks are exactly
what that check validates (facets present + drawn from the controlled vocabulary, a spec file exists
with non-empty `## Do`/`## Done when` sections, non-empty `scope`) — running it now catches an authoring
slip while it's still fresh, rather than the loop discovering it mid-run. Phrase it as a suggestion, not
a requirement — this command's job ends at a correctly-committed backlog; whether/when to start a run is
the owner's call.
