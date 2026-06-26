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
WORK   (claude) → one `claude -p` at the policy-chosen tier builds the task COLD in this checkout
                  on main, runs the Definition of Done (§5), and COMMITS (does NOT push).
GATE   (shell)  → pre-push guard (§4) → structural checks + sampled blocking audit (§5) → push main
                  → watch GitHub CI (§3) → green: mark `done`; red: revert + cold retry (escalate).
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

**The loop adds two gates beyond CI** (see `designs/audit-verification.md`). Before a built task is
pushed, the loop runs cheap **structural checks** (the diff is non-empty; every changed file is within
the task's declared `scope` — a hard blast-radius boundary, matched as an exact path or a directory
prefix so a `dir/**` entry admits anything beneath it; if the task sets
`expectsTest: true`, a test file changed; the `LOCAL_DOD` commands — `tsc`/`test` — pass), then — for
a *sampled* fraction of tasks — a **blocking audit**: a fresh, independent Claude (at
`max(opus-4.8/medium, the builder's tier)`) reads the spec's `## Done when` + the diff and must answer
`PASS`. A structural or audit failure is a failed attempt → cold retry → escalate, exactly like a red
CI; the work is never pushed. Audit sampling per `(layer × work-type)` cell starts at 100% and decays
to a 10% floor as the cell accumulates audit-confirmed successes — so a plausible-but-wrong build at a
cheap tier is caught, the task escalates, and the ledger learns the cell's true difficulty.

**Every attempt is COLD.** The loop `cold_reset`s to a clean `origin/main` before each (re)attempt, so
the builder never sees a prior attempt's worklog or partial work — each outcome measures whether that
tier can do the task in one cold pass. The worklog is written for humans but never read by the
builder. A task that can't be done cold in one pass is mis-sized → split it.

## 6. Model selection (auto-tuned — no per-task models)

Tasks do **not** carry per-task `model`/`effort`/`escalation` — difficulty is **auto-tuned** (see
`designs/difficulty-autotune.md`). The loop rides ONE global tier ladder (`facets.json →
.tiers.ladder`, cheapest→priciest) and a policy (`policy.jq`) picks each task's START tier from its
`(layer × work-type)` facet cell's escalation history (the cheapest tier clearing floor 0.75 with ≥6
samples; else the cold-start floor). After `MAX_ATTEMPTS` soft failures on a tier the loop climbs the
ladder; past the top tier it stops for a human. The ladder is deliberately SHORT (4 tiers:
`sonnet/low → sonnet/medium → sonnet/high → opus/high`), so a doomed task BLOCKS to a human after at
most `4×MAX_ATTEMPTS` attempts rather than burning the most expensive opus-effort tiers — if
`opus/high` can't do it twice, a human glance is cheaper than throwing `opus/max` at it. Every built
task's outcome is captured to `.harness/outcomes.jsonl` (the sole calibration input; forward-only).
The **cold-start floor** is the cheapest tier (`sonnet/low`, set in `harness.env`) — used until a cell
has enough samples.

**Two distinct ledgers.** `outcomes.jsonl` is one TERMINAL row per built task (where it ended up:
final tier, total soft-fails, blocked?) and feeds calibration. `failures.jsonl` is one row per FAILED
ATTEMPT (`{id, ts, kind, rung, attempt, model, effort, detail}`) with the cause — `scope-creep`,
`audit-fail`, `ci-red`, `test-missing`, … — so you can see the FULL escalation history (what failed
at each rung, and whether the causes were all the same), not just the summary. It's diagnostics only
(never read by calibration), buffered per-task in a gitignored scratch file (survives the cold reset
between attempts) and flushed into the committed ledger when the task terminates. Aggregate it with
`jq` to answer "which failure kind drives most escalations across tasks?".
`needs-human` tasks are carved out entirely (no facets, no calibration).

## 7. Usage-limit backoff (pause + cold re-attempt)

When `claude` hits the Claude Code usage/rate limit, the loop detects it in the CLI output, **sleeps
and re-attempts the SAME task COLD** (cold_reset first) — this is *not* a soft failure (no attempt
counted, no escalation); it just keeps every measured pass a clean cold one.
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
      "scope": ["src/…"], "verify": [], "expectsTest": false,  // expectsTest: true → audit's structural gate requires a test in the diff (§5)
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

**`expectsTest` (optional, default false) — the verification contract.** Set `true` on a task whose
correctness should be pinned by a test; the loop's structural gate (§5) then requires a test file to
change in the diff. Make `## Done when` concrete + runnable where possible so the blocking audit (and
you) can verify it objectively. Each ledger row records `verification: "audited" | "ci-only"` so the
calibration can weight audit-confirmed successes (see `designs/audit-verification.md`).

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

**Owner-owned overlay flags — `reviewed` (T136) and `done` (T208).** These are the
human/dashboard-owned pieces of backlog state. Both live **entirely outside TASKS.json**, in their
own committed files, and **the loop NEVER writes either file** (it only ever writes TASKS.json
`status` + the worklog). The loop's `jq` status write and the daemon's overlay writes can never
conflict — different files, always clean merges.

- **`.harness/reviews.json`** — `id → { "reviewed": bool, "at": <ISO-8601> }`. Set via
  `POST /api/backlog/:id/reviewed { reviewed }` or bulk `POST /api/backlog/reviewed-bulk`. Atomically
  writes the file (read-modify-write, temp-file + rename, field-scoped) then commits+pushes under the
  repo lock. `GET /api/backlog` overlays `reviewed = reviews[id]?.reviewed ?? false`.
- **`.harness/human-done.json`** (T208) — `id → { "done": true, "at": <ISO-8601> }`. Set via
  `POST /api/backlog/:id/done` (needs-human tasks ONLY — 400 otherwise). Same atomic write+commit+push
  pattern. `GET /api/backlog` overlays `done=true` and derives `reviewed=true` (done implies reviewed).
  TASKS.json `status` is NEVER modified. The Backlog page shows a **"Mark done"** button on
  needs-human tasks that aren't already done.

Both endpoints use the **SAME mkdir lock loop.sh uses** (`src/core/repo-lock.ts`, the
`<git-common-dir>/<basename(repo-root)>-loop.lock` dir with stale-pid-reclaim) — daemon git ops are
mutually exclusive with the loop. The push is **best-effort** (non-fatal warning on failure; the local
commit is the durability guarantee). The agent must NOT hand-edit either overlay file — they are owner
UI actions. **loop.sh and the daemon must agree on the lock path byte-for-byte** (see `repo-lock.ts`'s
header + loop.sh's `acquire_lock`).

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
