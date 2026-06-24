# HARNESS.md — the autonomous build harness (in-place Ralph loop)

Authoritative design of the autonomous builder for `local-jobs`. `CLAUDE.md` is the
coding-conventions rulebook; this file is how the loop *works*.

## 1. What it is

A single **sequential** shell loop (`.harness/loop.sh`) that builds the `.harness/TASKS.json`
backlog **one fully-verified task at a time**, working **directly on `main` in this checkout** —
no git worktree, no per-task branches. The whole harness lives under the hidden `.harness/` folder
to stay separate from project source. `.harness/supervise.sh` re-launches the loop on a cadence so
it spans many token-refresh windows.

### Why in-place (not the worktree variant)
The stock Ralph harness isolates each task in a throwaway worktree off `origin/main`. We
deliberately **don't** here:
- The real jobs (`src/jobs/places`, `src/jobs/perfumes`) and all their `data/` live **untracked**
  in this checkout. A clean worktree off `origin/main` literally can't see them, so it couldn't
  build or verify against them.
- The safety model is **git itself**: every task is one commit on `main`; a bad one is a one-line
  `git revert`. Simpler, and it keeps the loop able to use the real local data as test fixtures.

## 2. One iteration

```
SELECT (shell)  → next not-done task in LOCAL TASKS.json whose dependsOn are all done and which
                  is not a 🚦 gate / 🔒 needs-human / blocked task. None eligible → stop.
WORK   (claude) → one `claude -p` (per-task model/effort) builds the task IN THIS CHECKOUT on
                  main, runs the Definition of Done (§5), and COMMITS (does NOT push).
GATE   (shell)  → pre-push guard (§4) → push main → watch GitHub CI (§3) → green: mark the task
                  `done` in LOCAL TASKS.json; red: STOP for a human (revert is one line).
```

## 3. The CI gate

`REQUIRE_CI=1` (default): after the agent commits and the loop pushes `main`, the loop watches the
GitHub Actions workflow named `CI` for that commit. **Green → task marked done. Red → the loop
stops and alerts**; you revert (`git revert HEAD && git push`) and decide. The agent's *local* DoD
(which mirrors CI) is the primary gate, so red CI should be rare (environment drift). Set
`REQUIRE_CI=0` to merge on local DoD only (no GitHub round-trip).

## 4. The pre-push guard (load-bearing safety)

Because the loop pushes to a **public** repo autonomously and this checkout contains private data,
the loop refuses to push if the pending commits (`origin/main..HEAD`) touch any sensitive path:
`data/`, `.env*`, `chrome-profile/`, `*.pem`/`*.key`/`*.p12`, `service-account*`, or
`credentials.json`. A trip **halts the run** for a human. The agent is instructed to stage files
explicitly (never `git add -A`). (`.harness/TASKS.json` + `.harness/worklog/` are committed on
purpose, so they are not blocked.)

## 5. Definition of Done (must mirror CI exactly)

Run locally before committing; identical to `.github/workflows/ci.yml`:

```sh
npx tsc --noEmit                      # typecheck
npm test                              # unit suite (scratch DB; discovers *.test.ts)
npm --prefix dashboard run build      # only for dashboard/ changes
```

Plus: add unit tests for new behaviour; update docs in lockstep (§ CLAUDE.md); record empirical
observations the task's `verify` field asks for in `.harness/worklog/<TASK>.md`.

**Verify correctness — paid calls are allowed, frugally.** The one hard rule is **never exceed a
service's monthly cap** (enforced mechanically: the `service_usage` quota makes `callService` throw
`QuotaExceededError` at the ceiling). Within that, be frugal: try cached data under each job's
`data/` folder, synthetic fixtures, and the scratch DB **first**; make a live paid call (Google
Places / Gemini) or a live scrape only when correctness genuinely cannot be confirmed otherwise, and
then with the smallest sample (1–2 items). **Never skip verification to avoid spend** — an unverified
task is not done. (Only a task that would have to *exceed* the monthly cap to verify records
`failed:blocked`.)

## 6. Model selection (auto-tuned — no per-task models)

Tasks do **not** carry per-task `model`/`effort`/`escalation` — difficulty is **auto-tuned** (see
`designs/difficulty-autotune.md`). The loop rides ONE global tier ladder (`facets.json →
.tiers.ladder`, cheapest→priciest) and a policy (`policy.jq`) picks each task's START tier from its
`(layer × work-type)` facet cell's escalation history (the cheapest tier clearing floor 0.75 with ≥6
samples; else the cold-start floor). After `MAX_ATTEMPTS` soft failures on a tier the loop climbs the
ladder; past the top tier it stops for a human. Every built task's outcome is captured to
`.harness/outcomes.jsonl` (the sole calibration input; forward-only). The **cold-start floor** is the
cheapest tier (`sonnet/low`, set in `harness.env`) — used until a cell has enough samples.
`needs-human` tasks are carved out entirely (no facets, no calibration).

## 7. Usage-limit backoff (pause + auto-resume)

When `claude` hits the Claude Code usage/rate limit, the loop detects it in the CLI output, **sleeps
and resumes the SAME task** — this is *not* a soft failure (no attempt counted, no escalation).
Backoff is exponential from `RL_BACKOFF_MIN` (5 min) capped at `RL_BACKOFF_MAX` (~5 h, the refresh
window). `supervise.sh`'s ~5 h 15 m cadence is the outer backstop.

## 8. TASKS.json schema (committed; shell-owned status)

`.harness/TASKS.json` is the backlog and the source of truth for done/not-done + dependency order.
It is **committed** to the repo, but the **shell owns task status**: the loop sets a task's
`status` to `done` (and commits that one-line change with `[skip ci]`) only after CI is green — the
agent must not edit it.

```jsonc
{
  "version": 1,
  "tasks": [
    {
      "id": "T001", "title": "…", "status": "pending",   // pending | done  (SHELL-owned)
      // NOTE: NO `reviewed` field — since T136 it lives in owner-owned .harness/reviews.json
      "dependsOn": [], "gate": null,                      // gate: null | "gate" | "needs-human"
      "facets": { "layer": "ui", "workType": "style", "risk": [] },  // difficulty auto-tuning (OMIT for needs-human); values from .harness/facets.json
      "scope": ["src/…"], "verify": [],
      "spec": ".harness/tasks/T001.md"                    // do/doneWhen live in this MD (T131); NO per-task model/effort/escalation
    }
  ]
}
```

`gate:"gate"` = a human reviews the deliverable before dependents run; `gate:"needs-human"` = a
one-time human step (the agent prepares around it and records `failed:blocked`).

**`facets` — difficulty auto-tuning (see `designs/difficulty-autotune.md`).** Each BUILDABLE task
carries `facets: { layer, workType, risk[] }`, chosen from the controlled vocabulary in
`.harness/facets.json`. The loop's policy reads them to pick the task's STARTING tier from escalation
history (the outcomes ledger); until a `(layer × work-type)` cell has ≥ `minN` samples it cold-starts
at the cheapest floor (`sonnet/low`). `needs-human` tasks are CARVED OUT — they get **no** `facets`
and never enter calibration. Facets are normally assigned by the add-to-backlog skill; a buildable
task that's missing them **degrades gracefully** (the policy falls back to the cold-start floor) but
won't benefit from / contribute to calibration until tagged — so prefer authoring through the skill,
or add `facets` by hand.

**`do`/`doneWhen` live in a per-task Markdown spec (T131).** Each task's *what to build* and *the
bar for done* are NOT flat strings in TASKS.json — they live in a per-task Markdown file at
`.harness/tasks/TNNN.md` with exactly two sections, `## Do` and `## Done when`, referenced by the
task's `spec` field (a repo-relative path). This is more expressive than a JSON string and renders
cleanly on the dashboard. TASKS.json keeps **every other field** (the orchestration fields above —
`status`, `dependsOn`, `gate`, `facets`, `scope`, `tags`, `verify`, `design` — but NOT `reviewed`,
which lives in `.harness/reviews.json`, see below). The loop's per-task prompt reads all orchestration fields from JSON and
**appends the spec MD's full text** (`task_spec_rel` + `cat` in `loop.sh prompt()`);
`GET /api/backlog` inlines the file as `specContent` (`readTaskSpec`, confined to
`.harness/tasks/*.md`) and the Backlog page renders it as markdown.

**`reviewed` — owner-owned, in its OWN file (T136, was T124).** Whether the OWNER has personally
reviewed a `done` task is the ONE human/dashboard-owned piece of backlog state — and since T136 it
lives **entirely outside TASKS.json**, in its own committed file `.harness/reviews.json`: a JSON map
`id → { "reviewed": bool, "at": <ISO-8601> }`. TASKS.json tasks carry **no** `reviewed` field, and
**the loop NEVER writes reviews.json** (it only ever writes TASKS.json `status` + the worklog). This
makes the two writers fully decoupled — different files, so the loop's `jq` status write and the
daemon's review write can never conflict, and a merge is always clean.

`GET /api/backlog` (`readBacklog`) OVERLAYS the file: each task's `reviewed = reviews[id]?.reviewed
?? false`. The Backlog page's "Mark as reviewed" toggle calls `POST /api/backlog/:id/reviewed
{ reviewed }` — the **single deliberate dashboard→harness write** — which (a) ATOMICALLY writes the
entry (read-modify-write, temp-file + rename, field-scoped, stamping `at`) as the durability floor,
then (b) under the **SAME mkdir lock loop.sh uses** (`src/core/repo-lock.ts`, the
`<git-common-dir>/<basename(repo-root)>-loop.lock` dir with the stale-pid-reclaim protocol — so the
daemon's git ops are mutually exclusive with the loop) stages ONLY `.harness/reviews.json`, commits
it `reviews: <id> reviewed=<bool> [skip ci]`, and `fetch`+rebase+`push`es with a bounded retry. The
local commit is the guarantee; the push is **best-effort** — a failed push (offline / no remote)
returns `{ ok, reviewed, committed, pushed: false, warning }` (non-fatal), and the lock is always
released in a `finally`. So a review survives a daemon restart AND a working-tree reset, and reaches
GitHub. An absent entry reads as `false`. The agent must NOT hand-edit `reviewed`/reviews.json — it
is an owner UI action, just as `status` is a shell action. **loop.sh and the daemon must agree on
the lock path byte-for-byte** (see `repo-lock.ts`'s header + loop.sh's `acquire_lock`).

### Backlog authoring: a new task = JSON object + spec MD (T131)

Authoring a NEW backlog task is now **two coupled files**: (1) a JSON object in `TASKS.json` with a
`spec` field (`.harness/tasks/TNNN.md`) and the orchestration fields — but **no** `do`/`doneWhen`;
(2) the matching `.harness/tasks/TNNN.md` with `## Do` and `## Done when` sections. A task whose
`spec` file is missing renders with no body and feeds the loop a warning, so always create both in
the same backlog edit.

### Backlog authoring: pair chooser tasks with review tasks (T129)

Whenever you add a task that builds **multiple options for the owner to pick between** (toggleable
styles, strategy variants, etc.), you MUST also add a paired `"gate":"needs-human"` review task
that: (1) `dependsOn` the chooser, (2) has the owner record their choice, and (3) gates a
follow-up that hardcodes the winner and removes the toggle/unused variants. Authoring the chooser
without the review task is a backlog error. (See CLAUDE.md "Autonomous build harness" for wording +
examples: T099/T113/T116 choosers → T126/T127/T128 review tasks.)

## 9. Result protocol

The agent's final action writes one line to `.harness/worklog/.result`: `done <T>` /
`failed:soft <T> …` / `failed:blocked <T> …` / `waiting <T> …` / `idle`. The loop acts on it (§2).

## 10. Running it

```sh
DRY_RUN=1 .harness/loop.sh     # print the task it would build next
.harness/loop.sh               # build one task (or as many as fit the window)
.harness/supervise.sh          # leave running: re-launches the loop each ~5h15m window
.harness/postflight.sh         # zero-token status board (also written to .harness/worklog/STATUS.md)
```

Requirements: `jq`, `gh` (authenticated), Node 22. One loop at a time (a lock in `.git` enforces it).

## 11. Limitations
See [`LIMITATIONS.md`](./LIMITATIONS.md) §Harness.
