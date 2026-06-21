# .harness — autonomous build harness (Ralph loop)

Self-contained build harness for `local-jobs`, kept under a hidden `.harness/` folder so it
stays clearly separate from the project source. It builds a backlog one fully-verified task at
a time, working **directly on `main`** (no worktree), gated on green GitHub CI, pausing and
auto-resuming around Claude usage limits.

Full design: [`HARNESS.md`](./HARNESS.md). Trade-offs: [`LIMITATIONS.md`](./LIMITATIONS.md).

## Files

| Path | What |
|---|---|
| `loop.sh` | the loop — selects a task, runs Claude to build it, pushes, gates on CI |
| `supervise.sh` | re-launches `loop.sh` on a ~5h15m cadence (run this in a terminal) |
| `postflight.sh` | zero-token status board → also writes `worklog/STATUS.md` |
| `harness.env` | config (model, caps, CI gate, rate-limit backoff) |
| `TASKS.json` | the backlog (committed; the loop owns each task's `status`) |
| `worklog/` | per-task attempt notes (`<TASK>.md`); `.result`/`STATUS.md`/`.claude-out` are gitignored scratch |

The CI workflow lives at `.github/workflows/ci.yml` (GitHub requires that location — it's the
one harness piece that can't move under `.harness/`).

## Usage

```sh
DRY_RUN=1 .harness/loop.sh     # print the task it would build next
.harness/loop.sh               # build one task (or as many as fit the quota window)
.harness/supervise.sh          # leave running: re-launches the loop each window
.harness/postflight.sh         # status board
```

Requirements: `jq`, `gh` (authenticated), Node 22.

## Backlog (T001–T008)

1. **T001** — green CI baseline on the public checkout (fix `registry.test.ts`'s hardcoded counts)
2. **T002** — self-contain the perfume profile template (drop the external `/Users/...` path)
3. **T003** — publish `places` job code
4. **T004** — publish `perfumes` job code
5. **T005** — unit tests for the framework core
6. **T006** — validation gates between pipeline stages
7. **T007** — docs audit (README + CLAUDE.md vs repo)
8. **T008** — dashboard quick fixes

Live status is in `TASKS.json` (`status` per task) and the generated `worklog/STATUS.md`.
