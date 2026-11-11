# CLAUDE.md — src/workflows/vercel-daily-redeploy/

Once a day, at 23:00 (`0 23 * * *`), this workflow runs `vercel --prod --yes` in two separate
checkouts on this machine: `ryankrol.co.uk` and `PomoDiary`. Each is a real CLI production deploy
of that checkout's current working tree, not an HTTP call to a Vercel Deploy Hook. The late hour
is deliberate: it runs after a typical day's activity. `category: 'regular-maintenance'`.

**A run of this workflow deploys two live sites.** Do not start one to test a change. The tests
replace the spawn (`spawnFn`) and never call the real CLI.

## Two independent stages

| Stage | Checkout (env var) | Inputs | Outputs |
|---|---|---|---|
| `vercel-redeploy` | `RYANKROL_CO_UK_PATH` | none | `result` (`vercel-redeploy-result`, inline) |
| `vercel-redeploy-pomodiary` | `POMODIARY_PATH` | none | `result` (`vercel-redeploy-result`, inline) |

There is no edge between them, so one failing does not stop the other. `maxConcurrency: 1` means
they run one after the other. Both use the same runner, `runVercelRedeploy` in
`vercel-redeploy.job.ts`, with a `RedeployTarget` saying which job name, env var and file prefix
to use. This folder has no `stages/` subfolder and no `contracts.ts`: the two job files sit at
the folder root and the artifact type (`redeployResult`) is defined in `vercel-redeploy.job.ts`.
No stage declares `inputKeys()`, so the workflow is not limitable.

The `result` output is `{ generatedAt, key, outcome: deployed | skipped | failed, deployUrl?,
reason? }`. It is written whatever happened, including just before a failed deploy throws.

## What a stage does

It reads its checkout path from its env var. If the var is unset, or the path does not exist on
disk, it logs a warning and records a `skipped` outcome; the run does not fail. Otherwise it
spawns `vercel --prod --yes` with that path as `cwd`, sends every stdout and stderr line to
`ctx.log` (the CLI prints its normal build progress on stderr, so those lines are logged as
info, not warnings), and takes the last stdout line as the deploy URL. A non-zero exit code, a
spawn error or a timeout throws, so a failed deploy is a failed run on the dashboard.

Timeouts: the spawned `vercel` process is killed after 10 minutes by the stage itself. The job's
own `timeoutMs` is 11 minutes, so the subprocess is always cleaned up before the executor would
have to hard-kill the job process. `maxRetries` is 1, so a failed deploy is tried once more.

**No credential to provision.** The Vercel CLI already has a persistent login session on this
machine (`vercel whoami`), and the `ryankrol.co.uk` checkout's `.vercel/project.json` is already
linked, so the job relies on that global CLI auth and passes no token.

## Why a direct CLI deploy, not a Deploy Hook

`ryankrol.co.uk` deliberately disconnected its Vercel Git integration. That repo's own autonomous
harness was pushing commits every few minutes, and even a cancelled deploy counted against the
Hobby quota (100/day, 100/hour, 60/5min), so the Git connection itself had to come off (see that
repo's own `CLAUDE.md`, "Deploying"). Pushing to `main` no longer deploys anything there. That
repo ships through its own harness convention: a single "deploy task" that runs `vercel --prod`
directly. This workflow is a separate daily safety net for when that fails or a session forgets
to author a deploy task. A Deploy Hook would not do: it builds from the connected Git repo and
branch, and with the integration off it may not fire at all. `vercel --prod` deploys the local
working tree whatever the state of the Git integration.

For `PomoDiary` the intent is different: this daily deploy is the PRIMARY way that site ships,
not a safety net. That repo sets `git.deploymentEnabled: false` in its `vercel.json`, so pushes
to `main` create no Vercel deployments at all (the same Hobby-quota lesson, applied before it
burned the quota this time).

## The `vercel` service

The deploy (spawn and wait for exit) is wrapped in `callService('vercel', ...)`, governed by
`src/services/vercel.service.ts`: a `cli-tool` category, unpaid service with a daily and a
monthly cap (`VERCEL_DAILY_CAP` and `VERCEL_MONTHLY_CAP`, defaults 3 and 30, see `.env.example`).
It has no `ratePerMinute` or `minIntervalMs`, because a deploy takes minutes by itself. A
`QuotaExceededError` from the service is caught and logged as a warning, and the outcome is
recorded as `skipped` with a `quota-exhausted` reason. It does not fail the run, the same as an
unconfigured path.

Both stages draw on the same caps. With the defaults, one scheduled run uses 2 of the day's 3
deploys, and two deploys a day reach the monthly default of 30 about halfway through the month.
After that both stages skip until the month rolls over, unless the cap has been raised in `.env`
or on the dashboard's service limits.

## The ledger and the per-day file

Each stage records one row per run under its own job name (`vercel-redeploy`,
`vercel-redeploy-pomodiary`), keyed by `dayKey(now)` (the UTC day, `YYYY-MM-DD`), so a second
run on the same day overwrites that day's row. The row is `success` for a deploy or a skip and
`failed` for a failed deploy. A failed deploy therefore shows twice: as the failed run, and as a
`failed` row that can be queried later. `detail` carries the `outcome`, plus `deployUrl` for a
deploy or a `reason` for a skip or failure (`missing-config: ...`, `quota-exhausted: ...`, or the
deploy error message).

The same result is also written to a small JSON file, `data/out/vercel-redeploy-<day>.json` or
`data/out/vercel-redeploy-pomodiary-<day>.json`, and the row points at it with `detail.format:
'json'` and `detail.path`.
