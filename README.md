# local-jobs

A small, self-hosted **job orchestrator + dashboard** for an always-on Mac Mini.
**v1.0.0.**

One long-lived daemon (kept alive by launchd) schedules and runs all jobs in
isolated child processes, records every run to SQLite, and a Next.js dashboard
shows live progress, history, durations, and pass/fail — plus push alerts on
failure. Built to host long-running / headless local work (notably a Google
Places enrichment workflow) that doesn't fit serverless or a web request.

```
launchd ──keeps alive──▶ daemon ──spawns──▶ job (isolated child process)
                            │  scheduler (croner)        │ emits NDJSON
                            │  executor (timeout/retry)   ▼ progress + logs
                            │  HTTP API on :4789     SQLite (jobs/runs/logs)
                            ▼
                  dashboard (Next.js, :4788) ◀── polls the API, read-only
```

## Mental model: two separate things

- **The daemon** is the engine. It schedules and runs jobs and records results
  **even with no dashboard open and no browser running.** This is the part that
  must always be on for work to happen.
- **The dashboard** is just a window onto the daemon. Jobs run whether it's up
  or not; you keep it running only so you can glance at it anytime.

## Ports

| | URL |
|---|---|
| Daemon HTTP API | `http://127.0.0.1:4789` |
| Dashboard | `http://localhost:4788` |

(Both configurable — API via `LOCALJOBS_PORT`, dashboard via the `-p` flag in
`dashboard/package.json`.)

The API **binds to loopback (`127.0.0.1`) only** by default, so it isn't
reachable off the machine. CORS is an **allowlist** (the local dashboard
origins), never `*`, and the mutating endpoints (run/toggle/prune/…) accept
loopback callers only — a non-loopback caller must present a shared token.

**To reach the dashboard remotely, don't expose the API — proxy it.** The
dashboard browser fetches `/api/*` from its *own* origin, and the dashboard
server (running on the Mini) rewrites those requests to the loopback API
(`next.config.js` → `127.0.0.1:4789`). So a remote browser only ever talks to
the dashboard; the API stays bound to loopback and is never exposed. See
[Remote access over Tailscale](#remote-access-over-tailscale) below. (Exposing
the API directly — `LOCALJOBS_HOST` to an interface address + `LOCALJOBS_TOKEN`
+ the remote origin in `LOCALJOBS_ALLOWED_ORIGINS` — is still possible but
unnecessary with the proxy, and not recommended.)

## Remote access over Tailscale

Put the dashboard on your private [Tailscale](https://tailscale.com) tailnet —
reachable from your phone/laptop anywhere, but **not the open internet**. The
API never leaves loopback; only the dashboard origin is shared, and it proxies
the API server-side (see above), so the T023 guards (loopback bind, CORS
allowlist, mutation token) stay in front of the API untouched.

One-time setup on the Mini (after `tailscale up`):

```bash
# Serve the local dashboard onto the tailnet over HTTPS (tailnet-only).
tailscale serve --bg 4788

# Confirm — and confirm Funnel is OFF (Funnel = public internet; we do NOT want it).
tailscale serve status
tailscale funnel status      # should report no funnel configured
```

Then open `https://<machine>.<tailnet>.ts.net/` from any device on the tailnet.

- **Keep Funnel OFF.** `tailscale serve` is tailnet-private; `tailscale funnel`
  would publish to the whole internet. Never funnel this dashboard.
- Nothing else changes: the dashboard stays bound to `localhost` and the API to
  `127.0.0.1`. `tailscale serve` terminates on the Mini and forwards to the
  local dashboard, which proxies `/api/*` to the loopback API.

## Keep everything running all the time (the real setup)

Two one-time installs register both as **launchd user agents** — they start at
login and auto-restart if they ever crash. No `sudo` needed for these.

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
tail -f data/dashboard.out.log                    # dashboard activity
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

## Triggering jobs — two ways

**Workflows own scheduling.** There are no standalone jobs: every job belongs to a
workflow, and the *workflow* is the only thing that carries a cron schedule and an
enable toggle (a single job is just a one-stage workflow). A job's own `schedule`
field is not used — the workflow drives its members.

- **Scheduled:** a *workflow* declares a cron `schedule` in its manifest; the daemon
  fires it automatically. Nothing for you to do.
- **Manual:** dashboard → **Workflows → [workflow] → ▶ Run now** (or a single
  **Job → ▶ Run now** for an ad-hoc one-off). Good for testing.

You can also **pause** a workflow (the enable toggle on its page) without deleting it.

## Adding a job

Every job must be declared in a `*.workflow.ts` manifest — even a lone job, which
becomes a one-stage workflow. A job with **no** manifest is a configuration error
and the daemon **refuses to start** (it fails loud at load).

1. Create `src/jobs/<name>.job.ts` exporting a `JobDefinition`:
   ```ts
   import type { JobDefinition } from '../core/types.js';

   const job: JobDefinition = {
     name: 'cleanup-temp',
     description: 'Deletes stale temp files',
     timeoutMs: 600_000,      // killed if it runs >10 min; 0 = no timeout
     maxRetries: 1,
     async run(ctx) {
       ctx.log('starting');
       ctx.progress(50, 'halfway');
       // ...work... (throw to fail the run)
       ctx.log('done');
     },
   };
   export default job;
   ```
2. Declare it in a `*.workflow.ts` manifest (a one-stage workflow for a lone job;
   the workflow carries the `schedule`):
   ```ts
   import type { WorkflowDefinition } from '../core/types.js';

   const workflow: WorkflowDefinition = {
     name: 'cleanup-temp',
     description: 'Nightly temp-file cleanup',
     schedule: '0 4 * * *',   // 4am daily (croner); null = manual-only
     jobs: [{ job: 'cleanup-temp' }],
   };
   export default workflow;
   ```
3. Restart the daemon — jobs and workflows are **auto-discovered** (no registry to edit):
   ```bash
   launchctl kickstart -k gui/$(id -u)/com.ryankrol.localjobs
   ```

It then appears in the dashboard automatically with history tracked from run one.

> **Your jobs stay private by default.** This repo is public; it ships the
> framework and the **places** and **perfumes** workflows as
> worked examples. Every other `src/jobs/*.job.ts` (and any private subfolder you
> add) is gitignored, so the jobs you add stay local-only unless you choose to
> publish them. Every job's `data/` folder is **always** gitignored
> (`src/jobs/**/data/`) — only code is ever published, never datasets or output.
> Secrets always go in `.env` (gitignored), never in code — see `.env.example`.

> **Gotcha:** the daemon loads job code at startup, so **any change to job/daemon
> code needs a daemon restart** to take effect. The dashboard only needs a
> rebuild + restart when you change the *UI*, not when you add jobs.

## Dashboard pages

Nav: **Overview · Workflows · Services · Database · Backlog**

- **Overview** — six **clickable stat tiles** (Running / Succeeded / Failed /
  Cancelled / Stuck / Ignored); clicking a tile filters the workflow cards and
  run table below to that category. Also shows the **stuck items** list (items
  that gave up, won't retry), each with two manual controls: **↻ Unstick**
  (delete the ledger row so it retries fresh next run) and **✕ Ignore**
  (permanently park genuinely-bad-data items). Ignored items are the ONE
  manual-park concept: they drop off the stuck list, are **never counted as
  stuck**, are never reprocessed, and appear ONLY here — under the **Ignored**
  tile (click it to list them).
- **Workflows** — every workflow with schedule, enabled state, member-job count,
  and last/next run. Every job belongs to a workflow, so there is no separate
  standalone-jobs list; drill into a workflow to reach its member jobs.
- **Workflow detail** — ▶ Run now, enable toggle, full run history
- **Workflow run detail** — live framework logs, per-stage job outcomes and
  statuses, **grouped by stage with older cycles collapsed** (click to expand),
  overall progress bar (rolled up in real time from member-job progress)
- **Job detail** — ▶ Run now, enable toggle, full run history, per-job stuck
  items; reached via links from the Workflows page or stuck-items list (no
  top-level nav entry — use `/jobs/<name>`)
- **Run detail** — live progress bar + streaming logs, duration, exit code, error
- **Services** — per-service usage counts vs caps, current per-minute call rate,
  and **editable rate/quota limits** (override the code default; the override is
  persisted and preserved across daemon restarts / code-sync — same reconcile as
  the enabled toggle)
- **Database** — a strictly **read-only** SQLite view with two parts: a set of
  **named common queries** (recent failed runs, stuck & ignored items by job,
  work-items by status per job, service usage vs caps this month, recent
  workflow-run outcomes) and a raw **table browser** (pick a table, page through
  its rows). It is **not** a free-form SQL editor: the client only ever picks a
  query by id or a table by name — every query is a fixed, hand-written `SELECT`
  on the server, and table names are whitelisted against the live schema. Backed
  by read-only API paths (`GET /api/db/queries`, `/api/db/queries/:id`,
  `/api/db/tables`, `/api/db/tables/:name`) so the local DB can be inspected
  without building a bespoke endpoint per question. No write/mutation path is exposed.
- **Backlog** — a read-only, human-readable render of the harness task list
  (`.harness/TASKS.json`): each task as a card (id, title, depends-on, tags,
  model, what to do + done-when), split into **harness-buildable** and
  **🔒 needs-a-human** groups. Served via `GET /api/backlog`.

Every page is **responsive down to a phone-width (~402px) viewport**: wide tables
scroll sideways within their panel (the page itself never scrolls horizontally),
stat tiles collapse to two columns, key/value blocks stack, and the header nav
wraps. A local check enforces this — see below.

### Mobile styling check

`dashboard/scripts/mobile-check.mjs` loads every dashboard page in a headless
Chromium at an iPhone-17-class 402px viewport and asserts no horizontal overflow
and nothing crossing an element's boundary. It is **hermetic**: it starts a
production `next start` and serves all `/api/*` calls from synthetic in-process
fixtures (deliberately stuffed with long strings to stress the layout), so it
needs **no daemon, no SQLite, and makes no API calls**. It is a local check, not
part of CI. Run it (from the repo root, after building the dashboard) with:

```bash
cd dashboard && npm run build && cd ..
node dashboard/scripts/mobile-check.mjs
```

## Configuration

See `.env.example`:

| Var | Purpose |
|---|---|
| `LOCALJOBS_PORT` | API port (default 4789) |
| `LOCALJOBS_HOST` | API bind address (default `127.0.0.1`, loopback-only). Set to an interface address (e.g. Tailscale) only for remote access — pair with `LOCALJOBS_TOKEN` |
| `LOCALJOBS_ALLOWED_ORIGINS` | Comma-separated CORS allowlist (default the local dashboard origins). Never `*` |
| `LOCALJOBS_API_UPSTREAM` | *(dashboard server)* Where the dashboard proxies `/api/*` (default `http://127.0.0.1:4789`). Keep it loopback; the API is never exposed |
| `NEXT_PUBLIC_API_BASE` | *(dashboard browser)* Absolute API base for the browser. Blank = same-origin (proxied through the dashboard) — the default and recommended; set only to point the browser at a directly-exposed API |
| `LOCALJOBS_TOKEN` | Shared secret that non-loopback callers must send (`X-LocalJobs-Token` / `Authorization: Bearer`) to use mutating endpoints. Blank = loopback-only mutations |
| `LOCALJOBS_DB` | SQLite path (default `./data/jobs.db`) |
| `LOCALJOBS_NTFY_TOPIC` | [ntfy.sh](https://ntfy.sh) topic for phone push alerts on failure; blank = off (failures still recorded + a macOS notification fires) |
| `LOCALJOBS_NTFY_SERVER` | ntfy server (default `https://ntfy.sh`) |

## Worked example workflows

Both are published under `src/jobs/`; their `data/` stays gitignored.

**places** — Google Places enrichment. Four stages: `places-ingest` (parse
saved-place CSVs) → `cid-to-place-id-resolver` (headless CID→place_id) →
`places-enrich` (Google Places API) → `enrich-with-llm` (Gemini summaries →
markdown). Runs daily at 03:00. Needs `GOOGLE_MAPS_API_KEY` + `GEMINI_API_KEY`.
Spend is governed by `google-places`/`gemini` service quotas (capped at monthly/30
per day). See `places/config.ts` for the full env list.

**perfumes** — Fragrantica profile builder. Four stages: `perfumes-find-url`
(locate the page via the Claude CLI) → `perfumes-fetch` (headless Chrome /
Cloudflare clearance) → `perfumes-parse` (extract structured notes/accords) →
`perfumes-build` (research + write a markdown profile). Uses `repeatUntilStable`
cycling. Drives the local `claude` CLI. See `perfumes/config.ts` for models,
pacing, headless toggle, and dry-run options. See `.harness/LIMITATIONS.md` for
scraping trade-offs.

**Typed-artifact contracts.** Each stage boundary declares `produces`/`consumes`
contracts (`contracts.ts` in each workflow). A shape violation at a gate fails
LOUD — recording a failed run and firing an alert — instead of silently feeding
bad data downstream. Gates surface as chips on the workflow-run DAG in the
dashboard (green/pending/red, with a link to the failure logs when violated).
