# .harness/custom/README.md — project notes for the harness README

Customization overlay for `.harness/README.md`. Add project-specific notes here; harness upgrades never
touch this file. (See `.harness/custom/CLAUDE.md` for how the overlay works.)

<!-- Add your project-specific notes here. -->

---

## Project note (migrated from the former forked README)

# .harness — autonomous build harness (Ralph loop)

Self-contained build harness for `local-jobs`, kept under a hidden `.harness/` folder so it
stays clearly separate from the project source. It builds a backlog one fully-verified task at
a time, working **directly on `main`** (no worktree), gated on green GitHub CI, pausing and
auto-resuming around Claude usage limits.

Full design: [`docs/HARNESS.md`](./docs/HARNESS.md). Trade-offs: [`docs/LIMITATIONS.md`](./docs/LIMITATIONS.md).

## Files

Reorganized by kind (T327) — `docs/`, `config/`, `ledgers/`, `scripts/` group files that used to
sit flat at the top level. `TASKS.json`, `IDEAS.md`, and the owner-owned overlay files
(`human-done.json`, `manual-fail.json`, `reviews.json`) live under `tracking/` (moved there after
the T327 reorg) because code (`src/api/server.ts`) resolves them via a hardcoded path relative to
this directory. Each task's `## Do`/`## Done when` spec lives in its own file under `tasks/`.

| Path | What |
|---|---|
| `scripts/loop.sh` | the loop — selects a task, runs Claude to build it, pushes, gates on CI |
| `scripts/supervise.sh` | re-launches `loop.sh` on a ~5h15m cadence (run this in a terminal) |
| `scripts/postflight.sh` | zero-token status board → also writes `worklog/STATUS.md` |
| `config/harness.env` | config (model, caps, CI gate, rate-limit backoff) |
| `tracking/TASKS.json` | the backlog (committed; the loop owns each task's `status`) |
| `tracking/IDEAS.md` | gitignored ideas inbox (see root `CLAUDE.md`'s two-step ideas flow) |
| `tasks/TNNN.md` | per-task spec (`## Overview`/`## Do`/`## Done when`), referenced by `tracking/TASKS.json`'s `spec` field |
| `worklog/` | per-task attempt notes (`<TASK>.md`); `.result`/`STATUS.md`/`.claude-out` are gitignored scratch |

The CI workflow lives at `.github/workflows/ci.yml` (GitHub requires that location — it's the
one harness piece that can't move under `.harness/`).

## Usage

```sh
DRY_RUN=1 .harness/scripts/loop.sh     # print the task it would build next
.harness/scripts/loop.sh               # build one task (or as many as fit the quota window)
.harness/scripts/supervise.sh          # leave running: re-launches the loop each window
.harness/scripts/postflight.sh         # status board
```

Requirements: `jq`, `gh` (authenticated), Node 22.

## Backlog

Live status is in `tracking/TASKS.json` (`status` per task) and the generated `worklog/STATUS.md`.
