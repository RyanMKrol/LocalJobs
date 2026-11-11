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

Full design: [`docs/HARNESS.md`](../docs/HARNESS.md). Trade-offs: the harness's own are in
[`docs/LIMITATIONS.md`](../docs/LIMITATIONS.md), this project's in
[`custom/docs/LIMITATIONS.md`](./docs/LIMITATIONS.md).

## Files

Paths below are relative to `.harness/`. Files are grouped by kind (T327): `docs/`, `config/`,
`ledgers/` and `scripts/` hold what used to sit flat at the top level. `TASKS.json`, the ideas
inbox `IDEAS.jsonl` and the owner-owned overlay files (`human-done.json`, `manual-fail.json`,
`reviews.json`) live under `tracking/`. The backlog dashboard (`dashboard/server.js`, its own
launchd agent on port 4791) reads them from there; the product API in `src/api/server.ts` no
longer does. Each task's `## Do`/`## Done when` spec lives in its own file under `tasks/`.

| Path | What |
|---|---|
| `scripts/loop.sh` | the loop — selects a task, runs Claude to build it, pushes, gates on CI |
| `scripts/supervise.sh` | re-launches `loop.sh` on a ~5h15m cadence (run this in a terminal) |
| `scripts/postflight.sh` | zero-token status board → also writes `worklog/STATUS.md` |
| `config/harness.env` | config (model, caps, CI gate, rate-limit backoff) |
| `tracking/TASKS.json` | the backlog (committed; the loop owns each task's `status`) |
| `tracking/IDEAS.jsonl` | gitignored ideas inbox, one JSON object per line (see "Capturing ideas" in `custom/CLAUDE.md`) |
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
