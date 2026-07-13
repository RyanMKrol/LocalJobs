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

## Testing

`npm test` (root) runs every `*.test.ts` under `src/`, `scripts/`, AND
`dashboard/app/` — including two pure, no-browser dashboard suites
(`dashboard/app/components/OutputRenderer.test.ts`,
`dashboard/app/components/StageIoLists.test.ts`) plus the pure-helper suites
(`dashboard/app/ui.test.ts`, `dashboard/app/components/MarkdownModal.test.ts`).
These also run as their own `npm --prefix dashboard test` script and as a CI
step after the dashboard build. `dashboard/scripts/mobile-check.mjs` and
`dashboard/scripts/visual-check.mjs` (hermetic phone-viewport/screenshot
checks) and `dashboard/scripts/nav-check.test.ts` (a Playwright client-side-nav
check) are the exception: all three drive a real headless browser, so they stay
**local-only** — run them by hand after a dashboard UI change, but they are
never part of `npm test` or CI.

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

1. Create `src/workflows/<name>.job.ts` exporting a `JobDefinition`:
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
> `src/workflows/*.job.ts` (and any private subfolder you add) is gitignored, so the
> jobs you add stay local-only unless you publish them. Every job's `data/`
> folder is always gitignored. Secrets go in `.env` (gitignored), never in code.

> **Gotcha:** the daemon loads job code at startup, so any change to job/daemon
> code needs a daemon restart to take effect.

For full architecture, conventions, and how multi-stage workflows are structured
see `CLAUDE.md`.

## Shipped example workflows

Thirteen worked examples are published under `src/workflows/` (their `data/` stays
gitignored). Private workflows live in gitignored subfolders. Each workflow's full
current-state documentation lives in its own `CLAUDE.md` inside its folder — the
summaries below are a quick-reference index, not the source of truth.

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
- **workouts-sync** — Monthly Hevy workout ingestion: paginate the Hevy API →
  append each newly-synced workout's full data (title, exercises, sets) to a
  local full-history JSON file (`data/out/workouts-history.json`, no DynamoDB);
  idempotent per workout id (new workouts appended, already-synced ids skipped,
  so the history file only ever grows). Then a second stage computes a
  per-exercise 6-month progress report — best single set, total volume, and
  estimated 1-rep-max (Epley formula), comparing the most recently completed
  calendar month against the same month 6 months prior — and uses Claude to
  narrate it into `data/out/workouts-progress.md` (raw comparison also written
  to `data/out/progress-data.json`). Runs monthly on the 1st at 06:00.
- **listening-digest** — Monthly Last.fm listening digest: fetch top albums + top
  tracks TWICE (`period=1month` AND `period=3month`) directly from Last.fm's own
  aggregation endpoints (no raw scrobble ingestion, no DynamoDB), filter out
  single-track-dominated "albums" in each pass, and write TWO markdown reports to
  `data/out/` — a current-month digest and a trailing-3-month digest. Idempotent
  per calendar month via the work_items ledger (one ledger row per period); a
  manual re-run the same month regenerates both files in place. Runs monthly on
  the 1st.
- **projects-sync** — Weekly GitHub repo ingestion, 2-stage DAG. Stage 1 (`github-sync`)
  fetches the owner's repos via the GitHub REST API → filters out forks/archived/private
  → sorts by pushed_at → writes the filtered list to a local `data/out/projects.json`
  catalog; idempotent per GitHub numeric repo id (`repoId`) via the work_items ledger,
  refreshing fields every run. Stage 2 (`project-summarize`) shallow-clones each cataloged
  repo and gives Claude scoped, read-only filesystem access to explore it directly (package.json,
  source layout, README, other docs — not just its README), asking it (via the shared `claude-cli`
  service) to write a one-project markdown summary to `data/out/<repo-name>.md` that MUST follow the enforced
  `project.template.md` output contract (YAML frontmatter incl. `themes`/`domain` plus fixed
  `##` sections like `Themes & Interests` and `Notable Technical Approaches`, designed as a
  queryable cross-project "second brain" corpus, override via `PROJECTS_SYNC_TEMPLATE_PATH`) —
  a response missing the frontmatter marker or any required section is rejected and the item
  marked failed. Idempotent per repo by comparing the catalog's `pushedAt` against the
  last-processed marker stored on the work_items ledger — a repo unchanged since its last
  summary is skipped entirely (no clone, no Claude call). Runs weekly, Sunday at 05:00.
- **claude-warmer** — Proactive Claude usage-window warmer: issue one minimal `"hi"`
  prompt via the `claude-cli` service every 30 minutes so the Claude account's 5-hour
  rolling usage window is already running (or reset) by the time real work needs Claude.
  Soft-fails gracefully if the upstream plan limit is reached; no local quota cap needed.
  Runs every 30 minutes (`*/30 * * * *`).
- **stocks-sync** — Daily Trading212 portfolio snapshot + gain-alert, strictly **read-only**
  (GET-only, no order placement/cancellation/account mutation — see the "Broker / trading APIs
  are READ-ONLY" rule). 4-stage DAG. Stage 1 (`stocks-fetch`) calls Trading212's
  open-positions endpoint (https://docs.trading212.com/api) and writes raw, unresolved positions
  to `data/out/raw-positions.json`. Also fetches an OPTIONAL second Stocks & Shares ISA account
  (Trading212 API keys are scoped one key/secret pair per account) when
  `TRADING212_ISA_API_KEY_ID` + `TRADING212_ISA_API_SECRET_KEY` are both set; each position is
  tagged with which account it came from (`invest`/`isa`). Stage 2 (`stocks-snapshot`, depends on
  `stocks-fetch`) resolves each position's ISIN + real-world ticker and writes the final
  broker-agnostic snapshot to `data/out/portfolio.json` (structured) + `data/out/portfolio.md` (one
  row per position with the price difference since purchase, as both an absolute amount and a
  percentage, plus an Account column and a Real ticker column) — no DynamoDB. Idempotent per
  `account:ticker` via the work_items ledger. Stage 3
  (`stocks-watch`, depends on `stocks-snapshot`) checks EVERY position's gain since average buy
  price EVERY run and records it in the ledger unconditionally, then writes this run's fresh
  30%+ breaches to `data/out/fresh-breaches.json` — the check always reports success when it
  ran (it can never legitimately show as skipped/noop). Stage 4 (`stocks-notify`, depends on
  `stocks-watch`) reads `fresh-breaches.json` and sends **one** push naming every freshly
  breaching position, or does nothing if the file is empty (a real, expected noop, unlike
  stocks-watch). Notified once per breach episode (staying above 30% doesn't re-notify every
  run); if a position later drops back below 30% its notified-flag resets, so a future
  re-breach notifies again. Runs daily (schedule editable from the dashboard).
- **stock-digest** — Weekly Claude-narrated markdown summary of current stock
  holdings, performance movers, and a sector/diversification breakdown, DISTINCT
  from `stocks-sync` (own folder, own workflow, own weekly schedule —
  `'0 8 * * 1'`, Monday 08:00). Three-stage fan-in DAG: `stock-portfolio-snapshot`
  → both `stock-sector-lookup` and `stock-digest-build` (the latter depends on
  both — a genuine fan-in). **No inter-workflow dependency**: unlike an earlier
  design, `stock-digest` does NOT read `stocks-sync`'s output — `stock-portfolio-snapshot`
  fetches its own Trading212 snapshot independently (same credentials, own
  `data/out/portfolio.json`), resolving each position's ISIN + real-world ticker
  via OpenFIGI exactly like `stocks-sync` does. The Trading212 fetch/resolve logic
  is shared between the two workflows via `src/services/trading212.service.ts`
  (a top-level service, not a workflow-to-workflow read) so there's no duplicated
  implementation. Unlike `stocks-sync`'s per-`account:ticker` ledger,
  `stock-portfolio-snapshot` records ONE combined ledger row per run, keyed by the
  same ISO week key `stock-digest-build` uses — and that same key is threaded as
  the shared lineage `rootKey` through `stock-sector-lookup`'s per-ticker rows and
  `stock-digest-build`'s own row, so the dashboard's workflow-run Input → Output
  panel shows one coherent chain instead of three disjoint key spaces. `stock-sector-lookup` resolves each currently-held ticker's
  industry via the Finnhub company-profile API (`FINNHUB_API_KEY`), preferring
  the OpenFIGI-resolved real-world ticker over the raw/possibly-stale Trading212
  ticker when querying Finnhub, writing `data/out/sectors.json`; idempotent per
  ticker via the work_items ledger (already-resolved tickers are skipped on later
  runs). A missing/unset key soft-skips the lookup, and `stock-digest-build`
  simply omits the diversification section. `stock-digest-build` computes each
  position's gain since average buy price and its share of total portfolio
  value, ranks the biggest winners/losers, groups portfolio value by resolved
  industry, and asks Claude to narrate a holdings + performance + diversification
  report to `data/out/stock-digest-<ISO-week>.md`. Idempotent per ISO week via
  the work_items ledger. Markdown-only output — no push notification is sent.
  Runs weekly, Monday at 08:00.
- **vercel-daily-redeploy** — Once a day, runs `vercel --prod --yes` directly in
  the separate `ryankrol.co.uk` checkout — a real CLI production deploy, not an
  HTTP call to a Deploy Hook. Safety net: that repo ships via its own harness
  convention (a single deploy task that runs `vercel --prod`); this is a
  redundant daily backstop for when that mechanism fails or a session forgets to
  author a deploy task. No credential to provision — it relies on the Vercel
  CLI's own persistent login session already on this machine. `RYANKROL_CO_UK_PATH`
  (the checkout path) is optional — unset or a nonexistent path soft-skips the job
  cleanly (a warn log, no failure). Runs daily at 23:00 (`'0 23 * * *'`),
  deliberately late in the day.
- **plex-space-saver** — Weekly, report-only Plex disk-space breakdown, distinct
  from `missing-tv-seasons` (which audits missing seasons, not disk usage). Scans
  the Plex movie + TV sections via the API (each media Part's `size` in bytes —
  no filesystem walk) and writes a biggest-first size breakdown: one row per
  movie, one row per TV show (summing every episode across every season).
  Never flags or suggests deletions — a report only. Idempotent per ISO week via
  the work_items ledger. Single stage, runs weekly (Sundays 06:00).
- **plex-profiles** — Weekly, writes one markdown profile per Plex title (movie
  AND TV show) to `data/out/movies/` / `data/out/shows/`, sourced purely from
  the Plex API — no LLM. Each profile covers a summary, cast/crew, per-source
  ratings, technical detail (resolution/codec/file size, or total library size
  summed across every episode for a show), and source metadata, in a fixed
  YAML-frontmatter + `##`-heading template. Idempotent per title via the
  work_items ledger's stored `updatedAt` marker (mirrors `projects-sync`'s
  `pushedAt` idiom) — a title unchanged since its last build is skipped, so a
  re-run only rebuilds what actually changed. Single stage, runs weekly
  (Saturdays 05:00). Phase 2 (an optional Claude-narrated commentary layer on
  top) is a deliberately deferred, separate future task.
- **overrides-audit** — Weekly, report-only audit of every dashboard override
  currently set across services (rate/quota limits), workflows (schedule, max
  concurrency, notify-on-completion), and jobs (timeout). Reports any override
  that's either unknown-age (set before the age-tracking column existed) or has
  been live and unchanged for 2+ weeks, as a candidate to fold into its
  manifest/service-definition code default — a dashboard override is provisional,
  not a permanent home for a value. Never sends a notification, never writes to
  the ideas inbox, and never patches any file itself — folding an override into
  code stays a fully manual step. Idempotent per ISO week via the work_items
  ledger. Single stage, runs weekly (Sundays 07:00).

## Dashboard pages

Nav: **Overview · Workflows · Services · Database · Backlog**

- **Overview** — clickable stat tiles (Running / Succeeded / Failed / Cancelled /
  Stuck / Ignored); stuck-items list with per-item Unstick / Ignore controls and
  bulk actions.
- **Workflows** — every workflow with schedule, enabled state, member-job count,
  and last/next run. Drill in to reach member jobs.
- **Workflow detail** — ▶ Run now, enable toggle, editable schedule, editable max
  concurrency, a click-to-toggle **Notifications** switch (on/off for the run-end
  push notification; default on), full run history, and a **Danger zone → Clear
  output data** action.
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
- **Backlog** — human-readable render of the harness task list (`.harness/tracking/TASKS.json`),
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
