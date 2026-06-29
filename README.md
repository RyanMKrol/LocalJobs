# local-jobs

A small, self-hosted **job orchestrator + dashboard** for an always-on Mac Mini.

One long-lived daemon (kept alive by launchd) schedules and runs all jobs in
isolated child processes, records every run to SQLite, and a Next.js dashboard
shows live progress, history, durations, and pass/fail — plus push alerts on
failure. Built to host long-running / headless local work that doesn't fit
serverless or a web request.

```
launchd ──keeps alive──▶ daemon ──spawns──▶ job (isolated child process)
                            │  scheduler (croner)        │ emits NDJSON
                            │  executor (timeout/retry)   ▼ progress + logs
                            │  HTTP API on :4789     SQLite (jobs/runs/logs)
                            ▼
                  dashboard (Next.js, :4788) ◀── polls the API, read-only
```

- **The daemon** is the engine. It schedules and runs jobs and records results
  even with no dashboard open. It must stay running for work to happen.
- **The dashboard** is a read-only window onto the daemon. Jobs run whether it's
  up or not.

## Ports

| | URL |
|---|---|
| Daemon HTTP API | `http://127.0.0.1:4789` |
| Dashboard | `http://localhost:4788` |

The API binds to loopback only by default. CORS is an allowlist, never `*`.
Mutating endpoints accept loopback callers only (non-loopback callers need a
shared token). See `.env.example` for configuration.

## Remote access over Tailscale

Put the dashboard on your private [Tailscale](https://tailscale.com) tailnet —
reachable from your phone/laptop anywhere, but not the open internet. The API
never leaves loopback; only the dashboard origin is shared, and it proxies the
API server-side.

One-time setup on the Mini (after `tailscale up`):

```bash
tailscale serve --bg 4788
tailscale serve status        # confirm
tailscale funnel status       # must show no funnel configured
```

Then open `https://<machine>.<tailnet>.ts.net/` from any device on the tailnet.
**Never `tailscale funnel` this dashboard** — Funnel is public internet.

## Keep everything running all the time (the real setup)

```bash
cd ~/Development/local-jobs

# 1. the engine
bash scripts/install-launchd.sh

# 2. the always-on dashboard (build it first)
cd dashboard && npm run build && cd ..
bash scripts/install-dashboard-launchd.sh

# 3. stop the Mini sleeping so schedules actually fire (needs sudo)
sudo pmset -a sleep 0 disablesleep 1
```

After this you never manually start anything — reboot and both come back.

**Manage them:**
```bash
launchctl list | grep localjobs                 # both should appear
tail -f data/daemon.out.log                      # daemon activity
launchctl kickstart -k gui/$(id -u)/com.ryankrol.localjobs            # restart daemon
launchctl kickstart -k gui/$(id -u)/com.ryankrol.localjobs-dashboard  # restart dashboard
# uninstall:
launchctl unload ~/Library/LaunchAgents/com.ryankrol.localjobs.plist
launchctl unload ~/Library/LaunchAgents/com.ryankrol.localjobs-dashboard.plist
```

## Run it in dev (without installing services)

```bash
npm install
npm run daemon            # scheduler + API on :4789

cd dashboard
npm install
npm run dev               # dashboard on http://localhost:4788
```

## Triggering jobs

**Workflows own everything schedule-related.** Every job belongs to a workflow;
the workflow is the only thing that carries a cron schedule, an enable toggle,
and a run button.

- **Scheduled:** a workflow's cron `schedule` fires it automatically.
- **Manual:** dashboard → **Workflows → [workflow] → ▶ Run now**.
- **Edit schedule:** the workflow detail page's **Schedule** row has an Edit
  affordance — takes effect on the live scheduler with no daemon restart.
- **One active run per workflow at a time** — a second concurrent start is
  rejected (409 from the API, "Running…" in the UI).
- **Cancel:** a running workflow can be cancelled via the **✕ Cancel** button on
  the run detail page (hard-kills the in-flight child, marks the run `cancelled`).
- **Pause** a workflow via its enable toggle without deleting it.

## Adding a job

Every job must be declared in a `*.workflow.ts` manifest — even a lone job
(one-stage workflow). A job with no manifest is a config error and the daemon
**refuses to start**.

1. Create `src/jobs/<name>.job.ts` exporting a `JobDefinition`:
   ```ts
   import type { JobDefinition } from '../core/types.js';

   const job: JobDefinition = {
     name: 'cleanup-temp',
     description: 'Deletes stale temp files',
     timeoutMs: 600_000,
     maxRetries: 3,
     async run(ctx) {
       ctx.log('starting');
       ctx.progress(50, 'halfway');
       // throw to fail the run
     },
   };
   export default job;
   ```
2. Declare it in a `*.workflow.ts` manifest:
   ```ts
   import type { WorkflowDefinition } from '../core/types.js';

   const workflow: WorkflowDefinition = {
     name: 'cleanup-temp',
     description: 'Nightly temp-file cleanup',
     schedule: '0 4 * * *',   // croner syntax; null = manual-only
     jobs: [{ job: 'cleanup-temp' }],
   };
   export default workflow;
   ```
3. Restart the daemon — jobs and workflows are **auto-discovered** (no registry
   to edit):
   ```bash
   launchctl kickstart -k gui/$(id -u)/com.ryankrol.localjobs
   ```

> **Your jobs stay private by default.** This repo is public; every
> `src/jobs/*.job.ts` (and any private subfolder you add) is gitignored, so the
> jobs you add stay local-only unless you publish them. Every job's `data/`
> folder is always gitignored. Secrets go in `.env` (gitignored), never in code.

> **Gotcha:** the daemon loads job code at startup, so any change to job/daemon
> code needs a daemon restart to take effect.

For full architecture, conventions, and how multi-stage workflows are structured
see `CLAUDE.md`.

## Shipped example workflows

Five worked examples are published under `src/jobs/` (their `data/` stays
gitignored). Private workflows live in gitignored subfolders.

- **places** — Google Saved Places enrichment: parse CSVs → resolve CIDs →
  Google Places API → Gemini LLM summaries → markdown profiles. Daily at 03:00.
- **perfumes** — Fragrantica profile builder: find URL → headless-Chrome fetch →
  parse notes/accords → Claude CLI profile write. Uses `repeatUntilStable`
  cycling.
- **missing-tv-seasons** — Plex TV new-seasons audit: snapshot the TV library →
  check TMDB for complete missing seasons → weekly digest push (each missing
  season announced exactly once).
- **movie-recommendations** — Monthly Plex movie digest: snapshot the movie
  library → detect franchise gaps (TMDB Collections) AND fan out 8 Claude
  recommender branches → merge/verify/dedupe → one monthly digest of gaps +
  taste-based recommendations.
- **tv-recommendations** — Monthly Plex TV show recommendations: snapshot the TV
  library → 8 Claude recommender branches → merge/verify/dedupe → one monthly
  digest of new picks.
- **workouts-sync** — Daily Hevy workout ingestion: paginate the Hevy API → write
  each workout + its exercises to the existing DynamoDB tables; idempotent per
  workout id (new workouts synced, already-synced ids skipped). Runs daily at 06:00.

## Dashboard pages

Nav: **Overview · Workflows · Services · Database · Backlog**

- **Overview** — clickable stat tiles (Running / Succeeded / Failed / Cancelled /
  Stuck / Ignored); stuck-items list with per-item Unstick / Ignore controls and
  bulk actions.
- **Workflows** — every workflow with schedule, enabled state, member-job count,
  and last/next run. Drill in to reach member jobs.
- **Workflow detail** — ▶ Run now, enable toggle, editable schedule, editable max
  concurrency, full run history, and a **Danger zone → Clear output data** action.
- **Workflow run detail** — live logs, per-stage outcomes, overall progress bar,
  cancel button (while running), and an Input → Output mapping panel scoped to
  this run.
- **Job detail** — read-only member view: timeout/retries, run history, stuck
  items. You run + enable its *workflow*, not the job directly.
- **Run detail** — live progress bar + streaming logs, duration, exit code, error.
- **Services** — usage counts vs caps, current call rate, editable rate/quota
  limits, and a consumer list (which workflows/jobs have called each service).
- **Database** — read-only SQLite view: named common queries + a table browser.
  Not a free-form SQL editor.
- **Backlog** — human-readable render of the harness task list (`.harness/TASKS.json`),
  with per-task Do/Done-when rendered from spec files, and a reviewed toggle that
  commits + pushes durably to GitHub.

## Configuration

See `.env.example`:

| Var | Purpose |
|---|---|
| `LOCALJOBS_PORT` | API port (default 4789) |
| `LOCALJOBS_HOST` | API bind address (default `127.0.0.1`) |
| `LOCALJOBS_ALLOWED_ORIGINS` | Comma-separated CORS allowlist |
| `LOCALJOBS_TOKEN` | Shared secret for non-loopback mutating endpoints |
| `LOCALJOBS_DB` | SQLite path (default `./data/jobs.db`) |
| `LOCALJOBS_NTFY_TOPIC` | [ntfy.sh](https://ntfy.sh) push-alert topic; blank = off |
| `LOCALJOBS_NTFY_SERVER` | ntfy server (default `https://ntfy.sh`) |
