# CLAUDE.md — src/workflows/vercel-daily-redeploy/

A single-job workflow that once a day runs `vercel --prod --yes` directly in the separate
`ryankrol.co.uk` checkout — a real CLI production deploy of that repo's current working tree, not an
HTTP call to a Vercel Deploy Hook.

**Why a direct CLI deploy, not a Deploy Hook:** `ryankrol.co.uk` deliberately disconnected its Vercel
Git integration (that repo's own autonomous harness was pushing commits every few minutes, and even a
*cancelled* deploy counted against Hobby's quota — 100/day, 100/hour, 60/5min — so the Git connection
itself had to come off; see that repo's own `CLAUDE.md` "Deploying" section). Pushing to `main` no
longer auto-deploys anything there — that repo ships via its own harness convention (a single
always-at-most-one "deploy task" running `vercel --prod` directly). This workflow is a separate, daily
safety net for when that mechanism fails or a session forgets to author a deploy task. A Deploy Hook
isn't viable here (it builds from the connected Git repo/branch, and with Git integration off there's
real doubt one would even fire) — `vercel --prod` sidesteps that, deploying the current local working
tree independent of Git integration state.

**No credential to provision** — the Vercel CLI already has a persistent login session on this
machine (`vercel whoami`) and `~/Development/ryankrol.co.uk/.vercel/project.json` is already linked, so
`vercel-redeploy.job.ts` relies on that existing global CLI auth rather than a passed token.

Reads `process.env.RYANKROL_CO_UK_PATH` (the checkout path): unset or a nonexistent path soft-skips
with a clear WARN log; when valid it spawns `vercel --prod --yes` with that path as `cwd`, streams
every stdout/stderr line to `ctx.log`, and throws on a non-zero exit code or a spawn error (so a
dropped/failed deploy shows as a failed run in the dashboard rather than being silently swallowed).

Runs its own internal timeout-and-kill (10 min) separate from the job's outer `timeoutMs` (11 min) so
the spawned `vercel` subprocess is always killed cleanly before the executor would ever need to
hard-kill the job process itself.

No `work_items` ledger — pure fire-and-forget trigger, no items to track. Not yet gated through
`callService`/a `ServiceDefinition` (see backlog task T426, still pending). `category:
'regular-maintenance'`. Runs daily at 23:00 (`'0 23 * * *'`), deliberately late in the day, after a
typical day's activity on `ryankrol.co.uk`.
