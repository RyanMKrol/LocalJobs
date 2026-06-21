# local-jobs

A small, self-hosted **job orchestrator + dashboard** for an always-on Mac Mini.
**v1.0.0.**

One long-lived daemon (kept alive by launchd) schedules and runs all jobs in
isolated child processes, records every run to SQLite, and a Next.js dashboard
shows live progress, history, durations, and pass/fail — plus push alerts on
failure. Built to host long-running / headless local work (notably a Google
Places enrichment pipeline) that doesn't fit serverless or a web request.

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

- **Scheduled:** a job declares a cron `schedule` in its definition; the daemon
  fires it automatically. Nothing for you to do.
- **Manual:** dashboard → **Jobs → [job] → ▶ Run now**. Good for testing/one-offs.

You can also **pause** a job (the enable toggle on its page) without deleting it.

## Adding a job

1. Create `src/jobs/<name>.job.ts` exporting a `JobDefinition`:
   ```ts
   import type { JobDefinition } from '../core/types.js';

   const job: JobDefinition = {
     name: 'cleanup-temp',
     description: 'Deletes stale temp files',
     schedule: '0 4 * * *',   // 4am daily (croner); null = manual-only
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
2. Restart the daemon — jobs are **auto-discovered** (no registry to edit):
   ```bash
   launchctl kickstart -k gui/$(id -u)/com.ryankrol.localjobs
   ```

It then appears in the dashboard automatically with history tracked from run one.

> **Your jobs stay private by default.** This repo is public; it ships the
> framework and the **places** and **perfumes** pipelines as
> worked examples. Every other `src/jobs/*.job.ts` (and any private subfolder you
> add) is gitignored, so the jobs you add stay local-only unless you choose to
> publish them. Every job's `data/` folder is **always** gitignored
> (`src/jobs/**/data/`) — only code is ever published, never datasets or output.
> Secrets always go in `.env` (gitignored), never in code — see `.env.example`.

> **Gotcha:** the daemon loads job code at startup, so **any change to job/daemon
> code needs a daemon restart** to take effect. The dashboard only needs a
> rebuild + restart when you change the *UI*, not when you add jobs.

## Layout

```
src/
  config.ts            env-driven config (ports, db path, ntfy)
  daemon.ts            long-lived orchestrator entrypoint
  runJob.ts            child entrypoint: runs one job, emits NDJSON
  db/
    schema.sql         jobs · runs · run_logs · work_items · job_usage ·
                       pipelines · pipeline_runs · services · service_usage (WAL)
    index.ts           connection + schema bootstrap
    store.ts           ALL queries
  core/
    types.ts           JobDefinition, PipelineDefinition, ServiceDefinition,
                       JobContext, events
    executor.ts        spawn child, capture events, timeout-kill, retries
    scheduler.ts       croner triggers per scheduled job + pipeline
    dag.ts             pipeline DAG: topo sort + cycle detection
    pipeline-executor.ts  orchestrate pipeline runs; stage gates; member jobs; progress roll-up
    notifier.ts        ntfy + macOS notification on failure (+ stuck-items heads-up)
    services.ts        callService: cross-job rate-limit + quota middleware
    browser.ts         shared headless-browser launch (persistent profile +
                       real-Chrome channel) for reputation-gated scrapes
  jobs/
    registry.ts        auto-discovers *.job.ts, *.pipeline.ts, *.service.ts
    places/            published example pipeline: ingest → resolve → enrich →
                       llm-enrich (its data/ stays gitignored)
    perfumes/          published example pipeline: find-url → fetch → parse →
                       build (its data/ stays gitignored)
dashboard/             Next.js dashboard (client of the daemon's API)
scripts/               launchd install scripts + start wrapper
data/                  SQLite db + daemon/dashboard logs (gitignored)
```

## Dashboard pages

Nav: **Overview · Pipelines · Services · Database · Backlog**

- **Overview** — four **clickable stat tiles** (Running / Succeeded / Failed /
  Stuck); clicking a tile filters the pipeline cards and run table below to that
  category. Also shows the **stuck items** list (items that gave up, won't retry),
  each with two manual controls: **↻ Unstick** (delete the ledger row so it
  retries fresh next run) and **✕ Ignore** (permanently park genuinely-bad-data
  items so they drop off the list and are never reprocessed).
- **Pipelines** — every pipeline with schedule, enabled state, member-job count,
  last/next run; plus a **Standalone jobs** section for jobs not part of any pipeline.
- **Pipeline detail** — ▶ Run now, enable toggle, full run history
- **Pipeline run detail** — live framework logs, per-stage job outcomes and
  statuses, **grouped by stage with older cycles collapsed** (click to expand),
  overall progress bar (rolled up in real time from member-job progress)
- **Job detail** — ▶ Run now, enable toggle, full run history, per-job stuck
  items; reached via links from the Pipelines page or stuck-items list (no
  top-level nav entry — use `/jobs/<name>`)
- **Run detail** — live progress bar + streaming logs, duration, exit code, error
- **Services** — per-service usage counts vs caps, current per-minute call rate,
  and **editable rate/quota limits** (override the code default; the override is
  persisted and preserved across daemon restarts / code-sync — same reconcile as
  the enabled toggle)
- **Database** — a strictly **read-only** SQLite table browser: pick a table,
  page through its rows. Backed by a read-only API path (table names whitelisted
  against the live schema, only `SELECT` runs) so the local DB can be inspected
  without building a bespoke query per question. No write/mutation path is exposed.
- **Backlog** — a read-only, human-readable render of the harness task list
  (`.harness/TASKS.json`): each task as a card (id, title, depends-on, tags,
  model, what to do + done-when), split into **harness-buildable** and
  **🔒 needs-a-human** groups. Served via `GET /api/backlog`.

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

## Example pipeline: places

The Google Places "second brain" pipeline ships in-repo as a worked example
under `src/jobs/places/`, chaining four jobs (the `places` pipeline runs them in
order): `places-ingest` (parse saved-place CSVs) → `cid-to-place-id-resolver`
(headless CID→place_id) → `places-enrich` (Google Places API) → `enrich-with-llm`
(Gemini summaries → markdown). It reuses the same scheduling/visibility/alerting,
the per-item work ledger, and the spend caps. It runs **daily at 03:00**; because
both paid stages are metered, each one's daily cap defaults to its monthly free
allowance / 30 (`DAILY_SPEND_DIVISOR` in `config.ts`) so a daily run drains the
backlog steadily and can never blow the month. Each paid stage's spend is
governed by a single shared **service** quota (`google-places`, `gemini`) — when
it's exhausted the run stops gracefully and resumes next day. Its `data/` (inputs + outputs)
stays gitignored — only the code is published. It needs `GOOGLE_MAPS_API_KEY`
and `GEMINI_API_KEY` in `.env`; see the job's `config.ts` for the full env list
(rate limits, spend caps, dry-run toggles).

Stages can also declare **typed-artifact contracts** (`produces`/`consumes` on a
job): the pipeline validates them at each dependency boundary, so an upstream
external-format drift (a changed Google Takeout CSV layout, a reshaped
Fragrantica page) fails LOUD at the exact gate — recording a failed run and
firing an alert — instead of silently feeding bad data downstream.

## Example pipeline: perfumes

The perfume-profile pipeline ships in-repo as a second worked example under
`src/jobs/perfumes/`, chaining four jobs (the `perfumes` pipeline runs them in
order, serially): `perfumes-find-url` (locate the Fragrantica page via the Claude
CLI) → `perfumes-fetch` (headless Chrome fetch through Cloudflare clearance) →
`perfumes-parse` (extract structured notes/accords — each accord's strength `pct`
is lifted from the cached page HTML's coloured-bar width when an `<id>.html` is
present; an empty notes pyramid is normalized to explicitly-empty tiers, never
guessed) → `perfumes-build` (research + write a markdown profile from the
in-project `profile.template.md` — when Fragrantica gave no notes, the build
prompt keeps the notes empty and says so rather than fabricating a pyramid; and
the subjective community fields are blended against the LLM's own web research by
a **continuous sample-size confidence weight** `votes/(votes+k)`, where `k` is
calibrated to the scraped corpus's median vote count, so a niche house's
low-vote signal is down-weighted while a designer blockbuster's is trusted — the
chosen weighting is stated explicitly in the built profile, override `k` with
`PERFUMES_CONFIDENCE_K`). It shares the
same scheduling/visibility/alerting, the per-item work ledger, and `repeatUntilStable`
cycling. Its `data/` (the scraped inputs, generated markdown, and the Chrome
profile) stays gitignored — only the code is published. It drives the local
`claude` CLI; see the job's `config.ts` for the full env list (models, pacing,
headless toggle, dry-run). The published code documents the Fragrantica-scraping
technique — see `.harness/LIMITATIONS.md` for that trade-off.
