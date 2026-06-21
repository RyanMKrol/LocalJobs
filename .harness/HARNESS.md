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

**No live paid-API calls in verification.** Google Places / Gemini are metered with monthly caps.
Verify against the existing fetched data under each job's `data/` folder, or synthetic fixtures,
plus the scratch DB. If a check genuinely needs a paid call, the task records `failed:blocked`.

## 6. Models & escalation

Per-task `model`/`effort` in `TASKS.json` (Opus for code/complex, Sonnet for simple), falling back
to `defaults` then `harness.env`. After `MAX_ATTEMPTS` soft failures on a rung, the loop climbs the
task's `escalation` ladder (e.g. Sonnet→Opus); past the top rung it stops for a human.

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
  "defaults": { "model": "claude-opus-4-8", "effort": "high",
                "escalation": [ { "model": "claude-opus-4-8", "effort": "xhigh" } ] },
  "tasks": [
    {
      "id": "T001", "title": "…", "status": "pending",   // pending | done
      "dependsOn": [], "gate": null,                      // gate: null | "gate" | "needs-human"
      "model": "claude-opus-4-8", "effort": "high",       // optional per-task override
      "escalation": [ … ],                                // optional per-task ladder
      "scope": ["src/…"], "verify": [],
      "do": "what to build", "doneWhen": "the bar for done"
    }
  ]
}
```

`gate:"gate"` = a human reviews the deliverable before dependents run; `gate:"needs-human"` = a
one-time human step (the agent prepares around it and records `failed:blocked`).

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
