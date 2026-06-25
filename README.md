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

**Workflows own everything schedule-related.** There are no standalone jobs: every
job belongs to a workflow, and the *workflow* is the only thing that carries a cron
schedule, an enable toggle, and a run button (a single job is just a one-stage
workflow). A job has **no** schedule, enable toggle, instructions, or run-now of its
own — you run a *workflow*, never a job; a job runs when its prerequisites are met
inside its workflow.

- **Scheduled:** a *workflow* declares a cron `schedule` in its manifest; the daemon
  fires it automatically. Nothing for you to do.
- **Manual:** dashboard → **Workflows → [workflow] → ▶ Run now**. To run a single
  stage ad-hoc, make it (or wrap it in) its own one-stage workflow and run that.

**Edit a workflow's schedule from its detail page.** The **Workflows → [workflow]**
page's **Schedule** row has an **Edit** affordance: type a new cron expression (croner
syntax) and **Save**, or leave it blank to make the workflow **manual-only**. The
change is persisted, takes effect on the live scheduler **without a daemon restart**
(the `CronBadge` and **Next run** update on the next refresh), and — like the enable
toggle — is **user-owned**: a later code-sync preserves your edit instead of reverting
to the manifest's `schedule`. An invalid cron expression is rejected with a clear error
and never reaches the scheduler. Via the API: `POST /api/workflows/:name/schedule` with
`{ "schedule": "30 4 * * *" }` (empty string → manual-only; invalid → `400`).

**Edit a workflow's max concurrency from its detail page.** Independent stages run
in parallel up to a bounded cap (default **4**); the detail page's **Max concurrency**
row has the same **Edit → number → Save** affordance as Schedule. Like the schedule
and enable toggle it is **user-owned**: the edit is persisted, a later code-sync
preserves it (instead of reverting to the manifest's `maxConcurrency`), and it takes
effect on the **next run with no daemon restart**. The value must be a positive
integer ≥ 1 (`1` forces strictly-sequential stages). Via the API:
`POST /api/workflows/:name/concurrency` with `{ "maxConcurrency": 2 }` (invalid →
`400`); the effective value is exposed as `effective_max_concurrency` on
`GET /api/workflows/:name`.

**Limit a manual run to N originating inputs.** Beside ▶ Run now, a *limitable*
workflow shows a small number box (blank = all). Enter `N` to process only the
**first N originating inputs** — and **all** the fan-out work they spawn runs to
completion (the cap bounds the *roots*, not per-stage item counts). Use it to "run
the perfumes workflow for just 1 perfume" or "resolve + enrich just 5 places". Via
the API: `POST /api/workflows/:name/run` with `{ "limit": N }` (a positive integer;
rejected `400` if the workflow has no stage that declares input keys). **Scheduled
runs are always unlimited** — the limit is a manual-only option. The framework
tracks each work item's originating-input `root_key` so the same N inputs flow
through every stage even where the key changes (places: `cid → place_id`). A box
only appears when some member declares `inputKeys()` (the *root stage*); both
example workflows are limitable. The run's detail page shows a `limited · N inputs`
badge.

You can also **pause** a workflow (the enable toggle on its page) without deleting it.

**One run per workflow at a time.** A given workflow can only have **one active run**
at once (different workflows still run concurrently — it's per-workflow, not a global
lock). While a run is in flight its **▶ Run** button (on the Workflows list) and **▶ Run
now** button (on the workflow's page) are disabled and read **"Running…"**. Via the API,
`POST /api/workflows/:name/run` returns **409 Conflict** (`already has an active run`)
rather than appearing to start a second run, and the executor itself atomically refuses a
concurrent start of the same workflow — so even two near-simultaneous requests can't both
launch one. (Idempotency means there's nothing to gain from a second concurrent run — the
in-flight one is already doing the work.)

**Cancel a running workflow.** A workflow run that's mid-flight can be stopped via
`POST /api/workflow-runs/:id/cancel` (a mutating endpoint, so loopback or a token).
Cancelling **hard-kills the in-flight member's child process** (SIGTERM→SIGKILL — no
orphaned process), stops launching any further stages, and marks the workflow run and
the killed member run `cancelled` in the DB. Only a run that is currently `running`
*and* executing in the live daemon can be cancelled; a finished/unknown run returns a
clear error. (Jobs are idempotent, so the next scheduled or manual run resumes any
outstanding work.)

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
     maxRetries: 3,
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
> framework and the **places**, **perfumes**, **missing-tv-seasons**, and **movies** workflows as
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
  (permanently park genuinely-bad-data items). Clicking the **Stuck tile** (or
  the **"Manage all…"** button beside the stuck-items heading) opens a modal
  popover that lists stuck items with per-item ↻ / ✕ controls PLUS **"Unstick
  all"** and **"Ignore all"** bulk actions (each confirmed before executing).
  Ignored items are the ONE manual-park concept: they drop off the stuck list,
  are **never counted as stuck**, are never reprocessed, and appear ONLY here —
  under the **Ignored** tile (click it to list them).
- **Workflows** — every workflow with schedule, enabled state, member-job count,
  and last/next run. Every job belongs to a workflow, so there is no separate
  standalone-jobs list; drill into a workflow to reach its member jobs.
- **Workflow detail** — ▶ Run now, enable toggle, an **editable cron schedule**
  (Edit → type a croner expression or blank for manual-only → Save; persisted,
  user-owned, applied to the live scheduler with no restart), an **editable max
  concurrency** (Edit → number ≥ 1 → Save; user-owned, takes effect next run with
  no restart), full run history
- **Workflow run detail** — live framework logs, per-stage job outcomes and
  statuses, **grouped by stage with older cycles collapsed** (click to expand),
  overall progress bar (counts completed stages only — stays at 0% until the
  first member finishes, then steps in 100/N increments per completed stage).
  While the run is `running`, a **✕ Cancel** button appears next to the status
  badge; clicking it calls the cancel endpoint, disables itself during the
  request, and the next poll reflects the `cancelled` status. It also shows an
  **Input → Output mapping** panel that is **genuinely scoped to THIS run** — it
  lists only the originating inputs this run actually advanced (driven by the
  `work_item_runs` linkage `markWorkItem` records from `LOCALJOBS_WORKFLOW_RUN_ID`),
  each paired with its final output (joined by `root_key`). A run that advanced
  nothing new shows "This run processed no new items", and an old run created before
  this feature shows an honest "per-run input/output isn't recorded" note rather than
  dumping the whole work-item ledger; the one-output-per-input caveat is a subtle
  footnote. The **output side is expressive**: it previews
  the produced markdown artifact (title + a short excerpt) and **clicking it opens
  the full markdown in a popover** (rendered as formatted markdown via
  `react-markdown`; XSS-safe — no raw HTML execution; YAML frontmatter is stripped
  and shown as a compact key-value header). The content is served by a read-only,
  path-safe endpoint `GET /api/workflow-runs/:id/output?job=&key=` that resolves
  the file from the work item's recorded `detail.markdown` and only ever reads a
  `.md` file inside a job's own `data/out/` tree (no path traversal, files only,
  no paid/remote calls). Works for the places + perfumes example workflows.
- **Job detail** — a **read-only member view**: timeout/retries, full run history,
  and per-job stuck items. A job has no schedule, enable toggle, instructions or
  run-now of its own (you run + enable its *workflow*). Reached via links from the
  Workflows page or stuck-items list (no top-level nav entry — use `/jobs/<name>`)
- **Run detail** — live progress bar + streaming logs, duration, exit code, error
- **Services** — per-service usage counts vs caps, current per-minute call rate,
  and **editable rate/quota limits** (override the code default; the override is
  persisted and preserved across daemon restarts / code-sync — same reconcile as
  the enabled toggle). **Click a service name** to see which workflows/jobs have
  called it (service → workflow → job, backed by a runtime-recorded
  `service_consumers` table populated by `callService`)
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
- **Backlog** — a human-readable render of the harness task list
  (`.harness/TASKS.json`): each task as a card (id, title, depends-on, tags,
  difficulty), with its **Do** + **Done when** rendered as markdown from the
  task's per-task spec file (`.harness/tasks/TNNN.md`, referenced by the JSON
  `spec` field — T131), split into collapsible **harness-buildable**,
  **🔒 needs-a-human**, and **done** sections. Done items are collapsed by
  default and expand individually on click. Served via `GET /api/backlog`, which
  inlines each task's spec markdown as `specContent` for rendering, and **overlays**
  each task's `reviewed` flag from the owner-owned reviews store (defaulting to
  false). Each **done** task also has a **human-review toggle**: a "Mark as reviewed"
  button, a green **Reviewed** / muted **Not reviewed** pill, and a **Reviewed /
  Not-reviewed / All** filter on the done list. The toggle is the **one place the
  dashboard writes back to the harness**, and it now **persists durably** (T136):
  `reviewed` lives in its own committed file `.harness/reviews.json` (a
  `id → { reviewed, at }` map — separate from `.harness/TASKS.json`). Clicking it
  atomically writes that file AND the daemon **commits + pushes it to GitHub**
  immediately (under the same lock the autonomous loop uses), so a review **survives
  a daemon restart and a working-tree reset** and appears on the remote. Because the
  reviews file is a separate path from everything the loop commits, it **never
  conflicts** with the autonomous loop. A failed push (offline / no remote) is a
  non-fatal note — the commit still persists and syncs on the next push. Everything
  else on the dashboard remains read-only.

**Appearance switcher (🎨 in the header — T142, an evaluation aid).** A compact
header control opens a popover to mix-and-match three persisted (localStorage)
axes that apply live across **every** page: a **theme** (6 — 2 dark
*Default Dark* / *Midnight Neon* + 4 bright *Pixel Picnic* / *Candy Bright* /
*Sunny 8-bit* / *Soft Pastel*, each a full palette/texture/accent package), a
**display+body font pair** (8 — pixel/retro display faces like Pixelify, Silkscreen,
VT323, Press Start paired with readable body faces like Nunito, Quicksand, Fredoka,
Baloo, plus Space Mono / JetBrains; pixel faces only ever land on brand/headings,
never on tables/logs), and a **reduce-motion / minimise-emoji** toggle (defaults to
the OS `prefers-reduced-motion`). Joyful accents (a signature yellow-spark flash on
a succeeding run, hover-lift, animated progress fills, emoji status badges, friendlier
empty states) are baked into the non-default themes and dampened by the toggle. The
**untouched default stays the current dark + system-font look**, so nothing regresses.
A pre-paint script in `layout.tsx` applies the saved choices before first paint (no
theme flash). This is an evaluation aid — a follow-up (gated by review task T143)
hardcodes the chosen theme/font/motion and removes the switcher + unused options.

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

Both are published under `src/jobs/`; their `data/` stays gitignored. Each folder
keeps its shared files at the root (`*.workflow.ts`, `config.ts`, `types.ts`,
`contracts.ts`, helpers + template + `data/`) and groups its per-stage code under a
flat `stages/` subfolder. Shared **services** (the rate-limited / quota'd external
dependencies) are NOT inside a workflow — they're a daemon-wide concern, so they
live self-contained in the top-level `src/services/` (`gemini`, `google-places`,
`fragrantica`, `claude-cli`), each owning its own limits from env.

**places** — Google Places enrichment. Four stages: `places-ingest` (parse
saved-place CSVs) → `cid-to-place-id-resolver` (headless CID→place_id) →
`places-enrich` (Google Places API) → `enrich-with-llm` (Gemini summaries →
markdown). Runs daily at 03:00. Needs `GOOGLE_MAPS_API_KEY` + `GEMINI_API_KEY`.
Spend is governed by `google-places`/`gemini` service quotas (capped at monthly/30
per day). See `places/config.ts` for the full env list.

**perfumes** — Fragrantica profile builder. Four stages: `perfumes-find-url`
(locate the page via the Claude CLI) → `perfumes-fetch` (headless Chrome /
Cloudflare clearance — saves both the page text *and* the raw HTML so the parse
stage can read the accord-bar widths) → `perfumes-parse` (extract structured
notes/accords, lifting each accord's strength % off the saved HTML's bar widths) →
`perfumes-build` (research + write a markdown profile). Uses `repeatUntilStable`
cycling — it re-runs the DAG until no retryable work remains OR a whole cycle makes
**no forward progress** (a genuinely-unfindable input frozen below `maxAttempts`
would otherwise be counted "retryable" every cycle and spin the loop to `maxCycles`
for nothing; the run now stops early and flags the item for unstick/ignore). During
cycling, a stage's success/failed notification fires only when its status **changes**
from the last push, so a steady run no longer floods ntfy. Drives the local `claude`
CLI. See `perfumes/config.ts` for models, pacing, headless toggle, and dry-run
options. See `.harness/LIMITATIONS.md` for scraping trade-offs.

**missing-tv-seasons** — Plex TV new-seasons audit (served at
`/workflows/missing-tv-seasons`; was the `plex` workflow before T151). Three stages: `plex-tv-snapshot` (snapshot
the TV section by `tmdb://` GUID — each show + its highest owned regular season) →
`tmdb-season-check` (check TMDB for COMPLETE seasons you're missing; ended/canceled
shows included — revivals happen) → `plex-seasons-notify` (ONE weekly digest of the
newly-detected missing seasons). Scheduled weekly. Needs `PLEX_HOST` +
`PLEX_API_TOKEN` (Plex uses a self-signed cert — the TLS bypass is scoped to Plex
requests only) and `TMDB_API_TOKEN` (free), routed through the rate-limited `tmdb`
service. The Plex client **self-heals a changed DHCP IP**: if `PLEX_HOST` is
unset/stale it confirms the host (and, when `PLEX_MACHINE_ID` is set, that it's the
RIGHT Plex) and otherwise scans the local subnet for a Plex on `:32400`, caching the
resolved host for the daemon run and logging a heads-up to set `PLEX_HOST`. INVERTS the usual idempotency: it declares no `inputKeys()` (not limitable,
scheduled-only) and re-scans fresh every run — the `work_items` ledger lives ONLY in
the notify stage, as a "have I already notified this (show, season)?" log, so each
backlog season is announced exactly once.

**movies** — Plex movie franchise-gap audit. Three stages: `movie-snapshot`
(snapshot the movie section by GUID — each film + the taste metadata Plex returns:
genres/directors/decades/countries, written as a separate taste profile) →
`franchise-gaps` (the DETERMINISTIC detector via the TMDB **Collections** API: for
each owned film, resolve its `belongs_to_collection`, fetch each DISTINCT
collection's `parts[]`, and surface every RELEASED part you don't own — e.g. owning
9/10 Saw films flags Saw X) → `movie-gaps-notify` (ONE **monthly** digest of the
newly-detected gaps). Same connectivity as **missing-tv-seasons** (`PLEX_HOST`/`PLEX_API_TOKEN`/
`TMDB_API_TOKEN`, plus `PLEX_MOVIE_SECTION`, default 4) and the same inverted
idempotency (no `inputKeys()`, re-computes fresh, ledger only in notify). There is
**no quality filter and no skip heuristics** — every factual gap is surfaced; the
TMDB rating rides along for the owner's context only. Deduped per missing film so a
gap is announced once (first run = one big digest of the whole backlog). A gap leaves
future reports AND notifications ONLY when the owner manually **ignores** it. That
manage/ignore UI lives on the **movies workflow detail page** (`/workflows/movies`),
in a "Recommendations & gaps" section that lists every current gap grouped by
collection with a TMDB link + rating and an ✕ Ignore button →
`POST /api/movie-gaps/:tmdbId/ignore` → `ignoreSurfacedItem`, which parks the ledger
row `ignored`. (It used to be a dedicated top-level `/movie-gaps` page; T152 folded it
into the workflow's own page since it only manages this one workflow's outputs — the
section is gated to render only for the movies workflow.) Nothing auto-ignores.

The same monthly run ALSO produces taste-based **recommendations** (T146) — the
subjective half of the audit. Off the snapshot, **8 Claude recommender branches**
fan out (each calling the free Claude CLI via the shared `claude-cli` service on a
**stratified**, balanced-not-proportional sample of the owned library, so a 500-horror
library doesn't just yield more horror): **3 stratified-random** serendipity branches
(each a different seeded slice) + **5 targeted** — *auteur-completion* (more from
directors you collect ≥3 of) and *top-genre-canon* (canonical films in your strongest
genres) for depth, plus *thin-genre round-out*, *older-era classics* (pre-1980), and
*world cinema* (non-English) for breadth. Each asks for ~9 diverse un-owned films with
a reason (a larger ask gives headroom after filtering — T162); a branch that returns junk
or errors is skipped, never failing the run. The
`rec-merge` stage then enforces correctness in CODE so the model can't invent or repeat:
every suggestion is **TMDB-searched** (must resolve to a real id, must not be owned, must
not already be recommended/ignored — the `movie-recs` ledger keyed by recommended tmdb id),
must clear a **quality bar** (TMDB rating **≥ 7.0** with a meaningful **vote count ≥ 50**, so a
fluke high rating on a handful of votes can't sneak in — T162), then is deduped across
branches and **balanced per genre**. It targets **≥ 15** final picks: if fewer survive the
filters, a **bounded top-up loop** re-prompts the branches for ADDITIONAL films (excluding
everything already collected/owned/recommended this run), verifies + merges again, and
repeats up to a small capped number of rounds (Claude is free) — stopping early once the
target is hit or no new titles arrive, and outputting whatever it has if 15 quality picks
genuinely can't be found. The final
`movie-gaps-notify` digest + markdown report gain a **Recommendations** section separate
from the gaps, each rec showing its lens + reason + TMDB link; recommendations dedupe per
tmdb id (never re-recommended), are fed back into next month's prompts so picks vary, and
can be **ignore-to-suppress**'d like a gap. The quality bar (`MOVIES_RECS_MIN_RATING`,
`MOVIES_RECS_MIN_VOTES`), target (`MOVIES_RECS_TARGET`), top-up rounds
(`MOVIES_RECS_TOPUP_ROUNDS`), per-branch ask (`MOVIES_RECS_PER_BRANCH_ASK`), and the rest
are all `MOVIES_RECS_*` env-overridable (model, sample size, per-genre cap). Live LLM/TMDB
runs are the owner's.

**Typed-artifact contracts.** Each stage boundary declares `produces`/`consumes`
contracts (`contracts.ts` in each workflow). A shape violation at a gate fails
LOUD — recording a failed run and firing an alert — instead of silently feeding
bad data downstream. Gates surface as chips on the workflow-run DAG in the
dashboard (green/pending/red) — every chip is clickable and opens that gate's
dedicated detail page, which shows what the gate validates
(contract key + description, producer→consumer) and its outcome, with links to
the producer/consumer/violation run logs. The executor also logs each gate check
(what it asserted + the pass/fail result) into the workflow run's framework logs.

Each gate also has a dedicated page (click a gate chip / "detail →") that reads
as a **black box** — you understand the data without knowing the internals. It
lays the boundary out left-to-right: upstream stage **Output** → the **Gate**
(what it checks) → downstream stage **Input**. Each side shows the contract's
declared *expected shape* (a plain-English summary, the format, and the
fields/non-empty checks it asserts) and — by re-running the contract's `check()`
live against the artifact on disk — a per-expectation ✓/✗ against what *actually*
flowed plus a small sample/summary. A contract opts into this by adding an
`ArtifactShape` (`shape`) to its `ArtifactContract`; its `check()` returns
`checks[]` (per-expectation pass/fail, aligned by label) and a `sample`. Served
by `GET /api/workflow-runs/:id/gates/:producer/:key` (reads files only — never a
paid/remote call, so it's safe to poll).

In practice a gate references the **same contract** on both sides (e.g.
`fragranticaDataContract()` is both the producer's `produces` and the consumer's
`consumes`), so the Output and Input panels are identical. The page detects this
(the inspection endpoints return an `identical` flag — a deep compare of the two
sides' declared shapes) and **collapses to a single consolidated panel** (boundary
+ one expected shape + the actual ✓/✗ + sample), keeping every producer/consumer/
violation log link. An **asymmetric** gate — where the producer's `produces[key]`
and the consumer's `consumes[key]` declare *different* shapes (e.g. a fan-in DAG
with several producers feeding one consumer) — still renders the full two-sided
diff, and both sides' contracts are derived + enforced independently.

From a workflow's **definition** view (`/workflows/<name>`) — where there's no run
in scope — a gate chip instead opens a **run-agnostic** gate page that explains the
gate itself: the contract's artifact key, description, producer→consumer, and each
side's *expected shape*, with no per-run actuals (and the same identical-shape
collapse). It's served by the read-only
`GET /api/workflows/:name/gates/:producer/:key`, which returns the static contract
metadata only and never runs a contract `check()` (no file/paid/remote access).
