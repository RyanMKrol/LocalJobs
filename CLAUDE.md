# CLAUDE.md — working in this repo

Guidance for Claude when asked to change or extend this project.

## ⛔ Every session: read first, before any work

At the START of every session in this repo — before planning, answering, or
editing anything — **read these in full so you have current context:**

1. **This file (`CLAUDE.md`)** — architecture, conventions, how to add jobs.
2. **`README.md`** — what the app does and how it runs.

These are the source of truth for how this project works between sessions. They
are kept deliberately up to date (see the rule below), so trust them — but if
you find them contradicting the code, the code wins: fix the docs to match and
flag it to the user. Do not start work assuming you remember this project from a
previous session; re-read.

## ✅ Documentation is part of every change (Definition of Done)

**Any change to this repo is not "done" until the docs are updated in the same
change.** Keeping `CLAUDE.md` and `README.md` current is not optional cleanup —
it is part of the task. Treat stale docs as a bug.

Update the docs **as you go**, in the same edit/commit as the code, whenever you
change any of:

- **Jobs** — added/removed/renamed a job, or changed its schedule/behaviour
  → update the job list/roadmap in `README.md`.
- **Architecture or data flow** — new module, changed how the daemon/executor/
  scheduler/dashboard interact, new table/column → update the architecture
  section + file map in both files.
- **Commands, ports, or services** — new npm script, port change, new launchd
  agent, changed install/restart steps → update both files.
- **Conventions** — a new rule about how code in this repo should be written
  → add it to the Conventions section here.
- **Config** — new env var → update `.env.example` AND the config tables.

Before declaring a task complete, run this checklist:
1. Does `CLAUDE.md` still accurately describe how to work in the repo?
2. Does `README.md` still accurately describe what the app does and how to run it?
3. Did I add/rename anything that should appear in the file map, ports table, or
   job list?

If yes to a change and the docs don't reflect it, the task is **not done**.

## 🔐 Secrets & git hygiene (non-negotiable)

This repo is **public**. Two hard rules:

1. **Never commit credentials.** No API keys, AWS/GCP secrets, tokens, passwords,
   or private endpoints in any tracked file — not in code, not in docs, not in
   `.env.example` (use placeholders there). All secrets live in `.env`, which is
   gitignored and read via `process.env`. If a job needs a credential, document
   the env var name in `.env.example` and read it from the environment.
2. **Never commit private jobs.** The framework is public; the owner's actual
   jobs are not. Top-level `src/jobs/*.job.ts` files are gitignored. The `places/`
   and `perfumes/` subfolders are tracked as published examples — any new private
   workflow should live in its own subfolder added to `.gitignore`. Do not
   force-add private files.

Before any commit: `git status` and confirm no `.env`, no real `*.job.ts`, and
no credentials are staged. If you ever spot a secret about to be committed, stop
and tell the user.

## 🚫 Broker / trading APIs are READ-ONLY, always (non-negotiable)

Any job or service that talks to a stock/investment broker API (e.g. Trading212)
must be **strictly read-only**. This repo must **NEVER** issue a mutating request
to a broker — no placing, cancelling, or modifying an order; no transfers; no
account changes. Only `GET`/read endpoints (portfolio holdings, prices, account
value, order history as data) are permitted. This applies to every broker
integration added to this repo, present or future, not just the first one — treat
it the same way as the secrets rule above: a hard constraint, not a default that
can be relaxed for convenience. If a task would require a mutating call to
accomplish its goal, that's a sign the task is out of scope for this repo — stop
and flag it rather than making the call.

## ⚠️ Commit + push as you go — not optional (non-negotiable)

Make small, atomized commits **as each coherent change lands** — one per layer/feature,
not a big-bang at the end of a session — and **push each commit immediately**. Don't
batch work up "for later," don't defer a commit while you move on to the user's next
request, and don't wait to be asked. (Respect the git hygiene rules above: never commit
credentials or the gitignored private job folders / `TODO.md`.)

**Why this is a hard rule in THIS repo specifically, not just good practice:** the
autonomous build harness (`.harness/scripts/loop.sh`, run via `.harness/scripts/supervise.sh`) has
`LOOP_AUTORESET=1` by default (see `.harness/config/harness.env`). If the working tree is dirty
when a run starts, the loop **auto-stashes everything and hard-resets to `origin/main`**
before building — on purpose, so an unattended run always has a clean tree to start from.
An uncommitted session's work (a backlog sweep, a new workflow, a doc rewrite) can
silently disappear from view this way: not lost forever (`git stash list` recovers it),
but the loop will build against **stale state** — an old `TASKS.json`, missing doc
updates — until a human notices the stash and reconciles it. This has already happened
once: a full `/local-jobs-convert-ideas` sweep (13 new backlog tasks + supporting doc
changes) sat uncommitted across an entire session before anyone caught it via
`/local-jobs-pre-loop-checkin` — one skipped commit away from the loop silently stashing
away a whole idea-conversion sweep. Treat "uncommitted" as "not durable" here: the moment
a unit of work is coherent (a finished idea conversion, a completed doc update, a working
job), commit it and push it — don't let it accumulate.

## What this project is

`local-jobs` is a self-hosted job orchestrator + dashboard that runs on an
always-on **Mac Mini**. Its purpose is to host **long-running / headless local
work** that doesn't fit serverless or a web request. The repo ships four
worked-example workflows: **places** (headless CID→place_id resolution → Google
Places API enrichment → Gemini LLM summaries, writing enriched JSON + markdown
profiles to local files), **perfumes** (Fragrantica scrape → headless Chrome
fetch → parse → Claude CLI profile build), **missing-tv-seasons** (snapshot the Plex TV
library by GUID → check TMDB for complete missing seasons → weekly digest push;
the `src/jobs/plex/` folder, formerly the `plex` workflow),
and **movie-recommendations** (snapshot the Plex movie library by GUID → detect franchise gaps
via the TMDB Collections API AND fan out 8 Claude recommender branches over a
stratified library sample → a `rec-merge` stage that TMDB-verifies/dedupes/balances
the picks, enforces a quality bar (TMDB rating ≥7.0 with ≥50 votes) and targets ≥15
recs via a bounded re-prompt top-up loop (T162) → ONE monthly digest with separate
franchise-gaps + recommendations sections, both with owner ignore-to-suppress),
and **tv-recommendations** (`src/jobs/tv-recs/`) — a standalone TV show recommender (separate from
`missing-tv-seasons` which only audits missing seasons); complete DAG: `tv-snapshot → (8 branches)
→ tv-rec-merge → tv-recs-notify` (mirrors the movies fan-out pattern). `tv-snapshot` connects to
Plex via the shared plex client, reads the TV library section, builds a per-show snapshot keyed by
TMDB GUID + a taste profile (genres/roles/decades/countries), and writes `snapshot.json` +
`taste-profile.json` to `src/jobs/tv-recs/data/out/`. 8 recommender branches fan out in parallel
(3 random serendipity + 5 targeted). `tv-rec-merge` TMDB-verifies/dedupes/balances/tops-up into
`recommendations.json`. `tv-recs-notify` sends ONE monthly digest of new picks (announce-
exactly-once via the `tv-recs` ledger), drops owner-ignored shows, writes a markdown report to
`data/out/reports/tv-recommendations.md`, and appends notified shows to the history file.
and **workouts-sync** (`src/jobs/workouts-sync/`) — paginate the Hevy workout API
(`https://api.hevyapp.com/v1/workouts`) and append each newly-synced workout's full data (title,
exercises, sets) to a local, full-history JSON file (`data/out/workouts-history.json`, no
DynamoDB — matching the local-markdown/JSON-first direction of `listening-digest`/`projects-sync`/
`stocks-sync`); idempotent per workout id via the `work_items` ledger (new workouts are appended,
already-synced ids are skipped, so the history file only ever grows). Runs monthly (1st, 06:00) —
a same-day-fresh cadence isn't needed now that nothing downstream reads it in real time. No static
input list — inputs are discovered live from Hevy each run (like the plex audit workflows).
Rate-limited via `src/services/hevy.service.ts`. Credentials: `HEVY_API_KEY`. Stage 2,
`workouts-progress` (`dependsOn: ['hevy-sync']`), reads the full history file and computes a
per-exercise 6-month progress comparison — baseline period = the calendar month exactly 6 months
before the current period, current period = the most recently completed calendar month — across
three metrics: best single set (highest `weight_kg`, ties broken by `reps`), total volume
(`sum(weight_kg * reps)`), and estimated 1-rep-max (Epley: `weight_kg * (1 + reps / 30)`, max across
the period). Sets with a null `weight_kg`/`reps` (duration/distance-based exercises) are skipped
from all three metrics; an exercise with no usable sets in either period is excluded entirely. The
raw comparison is written to `data/out/progress-data.json`, then fed to `runClaude` (the shared
Claude CLI helper) to narrate it into `data/out/workouts-progress.md`. Idempotent per calendar month
via the `work_items` ledger (mirrors `listening-digest`) — a manual re-run the same month
regenerates the report (same static filename) rather than duplicating it.
and **listening-digest** (`src/jobs/listening-digest/`) — once a month, fetch Last.fm's own
aggregated `user.getTopAlbums` + `user.getTopTracks` (`period=1month`), filter out albums where a
single track accounts for ≥70% of the album's plays (a "one song on repeat" false-positive, mirrors
the same heuristic `ryankrol.co.uk`'s `/listening` page uses), and write a markdown digest to
`data/out/`. No DynamoDB — the website already reads Last.fm's period-based aggregation directly,
so there's no need to persist raw scrobbles. Single stage, not limitable (nothing to fan out over).
Idempotent per calendar month via the `work_items` ledger (keyed `YYYY-MM`); a manual re-run the
same month regenerates that month's file rather than duplicating it. Service:
`src/services/lastfm.service.ts`. Credentials: `LAST_FM_API_KEY`, `LAST_FM_USERNAME`.
and **projects-sync** (`src/jobs/projects-sync/`) — a 2-stage DAG. Stage 1, `github-sync`, fetches
the owner's GitHub repos via `GET /users/<GITHUB_USERNAME>/repos`, filters out forks/archived/private,
sorts by `pushed_at` descending, and writes the filtered list to a local `data/out/projects.json`
catalog (no DynamoDB). Idempotent per GitHub numeric repo id (`repoId`) via the `work_items` ledger —
re-scans every run so fields (description, topics, etc.) are refreshed. Stage 2, `project-summarize`
(`dependsOn: ['github-sync']`), shallow-clones each cataloged repo into a gitignored
`data/repos/<name>/` dir (pulling/reset instead of re-cloning if already present), then calls Claude
via a **DIFFERENT invocation shape from the shared `runClaude` helper (T320)**: `src/jobs/projects-sync/claude-repo.ts`'s
`runClaudeWithRepoAccess` spawns the CLI with `cwd` set to the cloned repo dir and
`--add-dir <repoDir> --allowedTools Read Glob Grep` (real, scoped, READ-ONLY filesystem tool access
— deliberately no `Bash`/`Write`/`Edit` or any mutating tool), so Claude explores the actual checked-out
project (package.json, source layout, README, other docs) itself instead of relying on a prompt-embedded
README slice. It is still gated through the same `claude-cli` service (`callService`, same rate-limit/quota
meter) as `runClaude` — only the CLI args/cwd differ; `src/services/claude.ts`'s `runClaude` itself is
UNCHANGED and still used, unmodified, by the perfumes build stage and the movies recommender branches.
The prompt (`buildSummaryPrompt`) still embeds the catalog metadata GitHub knows (name/description/
language/topics/pushedAt/url — unreachable from local file exploration alone) and instructs Claude to
explore the repo itself for everything else, writing a one-project markdown summary to
`data/out/<repo-name>.md` — the standard `detail.markdown` shape (T110) so it appears automatically in
the workflow's unified Output section (T205). **The output is an enforced template contract (T319,
mirroring perfumes' `profile.template.md` pattern):** `buildSummaryPrompt` embeds
`src/jobs/projects-sync/project.template.md` (override via `PROJECTS_SYNC_TEMPLATE_PATH`, config key
`projectsSyncConfig.templatePath`) and instructs Claude to follow it exactly — YAML frontmatter
(`name`/`full_name`/`url`/`language`/`topics`/`status`/`last_pushed`/`themes`/`domain`) plus fixed `##`
sections (`What It Is`/`Tech Stack`/`Status`/`Structure`/`Themes & Interests`/`Notable Technical
Approaches`/`Sources`) designed so the whole corpus of summaries is queryable for cross-project questions
("what kind of work am I interested in", "what have I built in domain X"). **Each section is expected to
be a couple of substantive paragraphs grounded in real repo exploration (T334), not a one-line
restatement of the catalog metadata** — both the template's per-section guidance and `buildSummaryPrompt`
explicitly ask for this depth (while keeping the existing "never invent facts" honesty instruction
intact; a small/dormant project may honestly say a section has little to add rather than pad it).
`templateShapeViolations`
validates the response post-hoc (leading `---` + every required heading); a shape mismatch throws with
the missing pieces named, routing through the existing `catch` → `markWorkItem(..., 'failed', ...)` path
— no new failure mechanism. Idempotent per
repo via a commit-sha-equivalent marker (the catalog's `pushedAt`): a repo whose stored marker
already matches the catalog's current value is skipped entirely (no clone, no Claude call) — there is
no separate calendar-based skip. Runs weekly, Sunday at 05:00.
Service: `src/services/github.service.ts`. Credentials: `GITHUB_USERNAME`, `GITHUB_TOKEN`. Model:
`PROJECTS_SYNC_CLAUDE_MODEL` (defaults to a Sonnet 5 id) at effort `PROJECTS_SYNC_CLAUDE_EFFORT`
(defaults to `medium`), shares `LOCALJOBS_CLAUDE_BIN`/`LOCALJOBS_CLAUDE_TIMEOUT_MS` via the
`claude-cli` service.
and **claude-warmer** (`src/jobs/claude-warmer/`) — issue one minimal Claude CLI prompt (`"hi"`,
cheapest model) every 30 minutes via `runClaude` in `src/services/claude.ts`. WHY: Claude accounts
have a 5-hour rolling usage window; this workflow fires proactively during off-hours so the window
is already running (or reset) by the time real work needs Claude. No local quota cap — the upstream
Claude plan enforces its own limit; if that limit is hit the CLI fails out and the job exits
cleanly (soft-fail). One stage (`claude-warm.job.ts`), `maxRetries: 0`, `timeoutMs: 60_000`.
and **stocks-sync** (`src/jobs/stocks-sync/`) — pull the owner's current open equity positions
from Trading212 (https://docs.trading212.com/api) via a **strictly read-only** integration
(GET-only, HTTP Basic auth with the key id as username and the secret key as password — see
`src/services/CLAUDE.md`) and write a local snapshot: `data/out/portfolio.json` (structured,
broker-agnostic `{ ticker, quantity, averageBuyPrice, currentPrice, currentValue, account }` array)
and `data/out/portfolio.md` (one row per position, including an Account column and the price
difference since purchase — `currentPrice - averageBuyPrice` — as both an absolute amount and a
percentage). No DynamoDB, matching the local-markdown-first direction of
`projects-sync`/`listening-digest`. **Also fetches an OPTIONAL second Stocks & Shares ISA account
(T301)** — Trading212 API keys are scoped ONE key/secret pair PER ACCOUNT, so Invest and ISA each
need their own separately-generated credentials — via `TRADING212_ISA_API_KEY_ID` /
`TRADING212_ISA_API_SECRET_KEY`; when both are set, `fetchPortfolio` is called a second time with
those credentials and the resulting positions are tagged `account: 'isa'` (vs `'invest'`) and
merged into the same combined list. Unset ISA credentials mean Invest-only, unchanged from
pre-T301 behavior. Stage 1 (`stocks-snapshot`), idempotent per **`account:ticker`** composite key
(`positionKey`) via the `work_items` ledger — NOT ticker alone, since the same ticker can be held
in both accounts and a bare-ticker key would collide; current price/value come directly from
Trading212's own portfolio endpoint (no separate market-data API or credential). **Also resolves
each position's ISIN + a current, real-world ticker (T373)** — Trading212's own `ticker` field can
go stale after a company rename (e.g. `YNDX_US_EQ` is actually Nebius Group NV, ISIN
`NL0009805522`, after its 2024 rename; Trading212 updated the `name` field but never the `ticker`).
`stocks-snapshot` calls Trading212's `GET /equity/metadata/instruments` endpoint (a SEPARATE, more
tightly rate-limited endpoint than the portfolio one — 1 request per 50 seconds per Trading212's
OpenAPI spec) **at most once per stage run** (never once per position), routed through
`callService('trading212', ...)` like the portfolio fetch, to build a ticker→ISIN lookup map; each
resolved ISIN is then resolved to a real ticker via the `openfigi` service (T372,
`fetchOpenFigiTickers`), batched to respect OpenFIGI's per-request job-count limit (10 without
`OPENFIGI_API_KEY`, 100 with one). `NormalizedPosition` gains two **optional** fields — `isin?` and
`resolvedTicker?` — populated when both lookups succeed; a miss at EITHER step (the Trading212
ticker isn't in the instruments-metadata response, or OpenFIGI returns `{ "warning": "No
identifier found." }` instead of `data`) is a soft skip: `ctx.log('warn: ...')` names the
unresolved ticker/ISIN and the position is written with both fields `undefined`, never failing the
whole snapshot. The existing `ticker` field is untouched — it stays the join key back to
broker/ledger data. `data/out/portfolio.json` includes the two new fields when present;
`data/out/portfolio.md` shows the resolved real ticker as a "Real ticker" column, falling back to
`—` when a position has no `resolvedTicker`.
Stage 2 (`stocks-watch`, `dependsOn: ['stocks-snapshot']`) reads that snapshot and, EVERY run, for
EVERY position, computes its gain since average buy price and calls `markWorkItem` unconditionally
— so this check stage always has ledger activity and can never be misclassified as noop by the
framework's `hasJobAdvancedAnyItem` heuristic (T300; the pre-T300 combined stage only wrote the
ledger on a fresh breach or a threshold-drop reset, so a quiet run with nothing breaching called
`markWorkItem` zero times and was wrongly reported as skipped even though it did real work). Whether
a position is a **fresh** breach (>=30% AND not already notified) is tracked on a SEPARATE ledger
key (`<account:ticker>::notified`, distinct from the per-run check key `<account:ticker>`) — a fresh breach sets it,
staying above 30% leaves it untouched, and dropping back below 30% resets it (marked `skipped`,
which `isWorkItemDone` treats as not-done) so a later re-crossing is fresh again. This run's fresh
breaches are written to `data/out/fresh-breaches.json` (empty array if none) for the next stage.
Stage 3 (`stocks-notify`, `dependsOn: ['stocks-watch']`) reads `fresh-breaches.json` and, if
non-empty, sends **one** push (via `push()` from `src/core/notifier.ts`, not the generic aggregate
`notifyWorkflow`) naming every freshly breaching position — reusing `buildDigest`/`formatBreachLine`.
If empty, it does nothing; unlike `stocks-watch`, `stocks-notify` legitimately shows as noop/skipped
in that case (there was genuinely nothing to send this run) — only the checking work being
mislabeled skipped was the bug this split fixes. Multiple positions freshly breaching in the same
run are combined into a single push, not one per position. Runs daily (schedule editable from the
dashboard). Service: `src/services/trading212.service.ts`.
Credentials: `TRADING212_API_KEY_ID`, `TRADING212_API_SECRET_KEY`. **`outputJob: 'stocks-snapshot'`
(T348)**: the DAG's true terminal stage, `stocks-notify`, never records `work_items` rows (it's a
pure notify-trigger), so the workflow manifest overrides the unified Output section (T205) to read
`stocks-snapshot`'s ledger instead, showing the current ticker positions.
and **stock-digest** (`src/jobs/stock-digest/`) — a weekly, Claude-narrated markdown summary of the
owner's current stock holdings, DISTINCT from `stocks-sync` (which only snapshots + threshold-alerts;
`stock-digest` is its own workflow, own folder, own schedule, per explicit owner direction — not a
stage bolted onto `stocks-sync`). **Three-stage fan-in DAG (T382, was a 2-stage cross-workflow-read
design as of T338/T337 — see below for why that changed):** `stock-portfolio-snapshot` fans out to
BOTH `stock-sector-lookup` (`dependsOn: ['stock-portfolio-snapshot']`) AND `stock-digest-build`
(`dependsOn: ['stock-portfolio-snapshot', 'stock-sector-lookup']` — a genuine fan-in: it reads both
the portfolio snapshot directly and, once sector-lookup has run, the sector map). Not limitable
(nothing to fan out over at the digest level), scheduled weekly (`'0 8 * * 1'`, Monday 08:00).

**NO inter-workflow dependency (T382 — reverses the T337/T338 cross-workflow-read design):**
`stock-digest` used to read `stocks-sync`'s `data/out/portfolio.json` directly via a plain relative
import of `stocksSyncConfig`/`NormalizedPosition`. Per explicit owner direction, this coupling was
removed: `stock-digest` now fetches its OWN Trading212 snapshot via a new first stage,
`stock-portfolio-snapshot` (`src/jobs/stock-digest/stages/stock-portfolio-snapshot.ts`), writing its
own `data/out/portfolio.json` — completely independent of whatever `stocks-sync` has or hasn't done.
This required promoting the actual Trading212 fetch/normalize/ISIN-resolve logic (previously owned
outright by `stocks-sync`'s `stocks-snapshot` stage) into the shared, top-level, daemon-wide
`src/services/trading212.service.ts` — mirroring how `openfigi.service.ts` already mixes its
`ServiceDefinition` with real fetch functions — so BOTH `stocks-sync` and `stock-digest` import the
SAME `fetchPortfolio`/`fetchInstrumentsMetadata`/`normalizePosition`/`positionKey`/`resolveTickers`/
`resolveOpenFigiTickersBatched`/`NormalizedPosition` from that one service module. This is a shared
top-level SERVICE dependency (the established, intended pattern for cross-job code reuse in this
repo), not an inter-*workflow* dependency — `stocks-sync`'s `stocks-snapshot` stage and
`stock-digest`'s `stock-portfolio-snapshot` stage each independently call the shared service with
their own credentials each run; neither reads the other's output file. `stock-portfolio-snapshot`
reads the SAME `TRADING212_API_KEY_ID`/`TRADING212_API_SECRET_KEY`/`TRADING212_ISA_API_KEY_ID`/
`TRADING212_ISA_API_SECRET_KEY` env vars as `stocks-sync` (one Trading212 account, two independent
consumers) and resolves each position's ISIN + real-world ticker via OpenFIGI exactly like
`stocks-snapshot` does (T373) — records one `work_items` ledger row per `account:ticker`
(`stock-portfolio-snapshot` job name) and writes `data/out/portfolio.json` (stock-digest's own,
distinct file from `stocks-sync`'s). A missing or empty portfolio (Trading212 briefly returns
nothing, or credentials are unset) is handled with a clear WARN log and a clean skip in both
downstream stages, not a crash.

Stage 2, `stock-sector-lookup`, resolves each currently-held ticker's industry via a new **Finnhub**
service (`src/services/finnhub.service.ts`, `GET /stock/profile2?symbol=<TICKER>&token=<KEY>`,
read-only/GET-only, gated through `callService('finnhub', ...)`) and writes a ticker→industry map to
`data/out/sectors.json`. **The query symbol prefers the OpenFIGI-resolved real-world ticker (T382)
over the crude `toFinnhubSymbol` string-strip (T352):** for each position, `resolvedTicker` (from
`stock-portfolio-snapshot`'s ISIN/OpenFIGI resolution, T373) is used as the Finnhub query symbol when
present; only when a position has no `resolvedTicker` does it fall back to `toFinnhubSymbol`, which
strips a trailing `_EQ` and, if what remains ends in a 2-letter uppercase market/country code, strips
that too (`AMD_US_EQ` → `AMD`, `VUSA_EQ` → `VUSA`) — Finnhub doesn't recognize Trading212's raw
ticker format and silently returns an empty profile rather than erroring. This fixes the same class
of staleness T373 fixed for `stocks-sync`: a company rename (e.g. a stale Trading212 ticker after a
2024 rename) no longer sends a dead symbol to Finnhub. (`toFinnhubSymbol`'s known residual
limitation — a class-share ticker like `BRK_B_US_EQ` strips to `BRK_B`, not Finnhub's exact expected
form — still applies to the fallback path only.) The `work_items` ledger stays keyed by the
ORIGINAL Trading212 ticker (matching `sectorBreakdown`'s lookup key in `stock-digest-build`), with
the actually-queried symbol recorded in `detail.queriedSymbol` for debugging. Idempotent per ticker
via the `work_items` ledger — a ticker already recorded `success` (a resolved industry) is skipped on
later runs (industry classification rarely changes, and this conserves the free-tier quota); an
unresolved lookup (no `finnhubIndustry` returned) is recorded `'failed'` rather than a misleading
`'success'`, so it retries automatically (capped at `MAX_ATTEMPTS`, after which it surfaces on the
dashboard's Stuck tile like any other stuck item); a newly-appeared ticker is looked up fresh. A
one-time `scripts/reset-stock-sector-lookup-null-successes.ts` clears ledger rows the pre-T352 bug
had already poisoned (recorded `'success'` with a null industry) so they re-resolve on the next run.
Credentials: `FINNHUB_API_KEY` — unset key soft-skips the whole stage (clear WARN, no crash), which
just means `stock-digest-build`'s diversification section is omitted that run.

Stage 3, `stock-digest-build`, computes, in code (never left to Claude to infer), each position's
gain since average buy price (`(currentPrice - averageBuyPrice) / averageBuyPrice`, the same formula
`stocks-watch` uses) and its share of total current portfolio value, ranks the top winners/losers,
groups portfolio value by resolved Finnhub industry (`sectorBreakdown` — % of total value per
industry; tickers with no resolved sector are excluded from the breakdown, and the breakdown/whole
diversification section is simply omitted when `sectors.json` is missing or has no resolved
entries), and feeds a structured JSON facts object to `runClaude` (`src/services/claude.ts`) asking
it to narrate a holdings section (ticker, quantity, current value, % of total portfolio), a
performance section (winners/losers, biggest % movers), and — when sector data exists — a
diversification section (% of portfolio value per industry, explicitly noted as Finnhub's own
industry classification rather than a formal GICS sector) as markdown — Claude narrates/formats
prose, it never invents the numbers. Output is written to `data/out/stock-digest-<weekKey>.md` (ISO
week key, e.g. `2026-W27`) and recorded via `markWorkItem(ctx, weekKey, 'success', { detail: {
markdown } })` (T110), so it surfaces in the workflow's unified Output section automatically.
Idempotent per ISO week via the `work_items` ledger — a manual re-run the same week regenerates that
week's file rather than duplicating it. **Markdown-only output — no push notification is sent
anywhere in this workflow**, mirroring `listening-digest`. Model: `STOCK_DIGEST_CLAUDE_MODEL`
(defaults to a Sonnet 5 id) at effort `STOCK_DIGEST_CLAUDE_EFFORT` (defaults to `medium`), gated
through the same `claude-cli` service as every other Claude caller. **The raw `facts` JSON handed to
Claude is also persisted per week (T362)**, written to `data/out/stock-digest-facts-<weekKey>.json`
(via `factsPathFor` in `config.ts`) BEFORE the Claude call, so it's on disk for debugging even if
that call throws. `runStockDigestBuild` also runs a **soft ticker cross-check**: after narration, it
scans Claude's markdown text for ticker-shaped tokens (`extractCandidateTickers`) and flags any that
aren't in `facts.holdings` and aren't a known non-ticker acronym (`findUnknownTickers` /
`KNOWN_NON_TICKER_TOKENS`, a living stoplist — e.g. `ISA`, `USD`, `ETF`), logging a single `warn:`
line naming them. This is a soft signal only — it never throws, skips the write, or changes the
`markWorkItem` outcome; it exists purely so a genuine future narration hallucination shows up in the
run's own logs instead of requiring manual log archaeology.
and **vercel-daily-redeploy** (`src/jobs/vercel-daily-redeploy/`) — a single-job workflow that once a
day POSTs to a Vercel Deploy Hook for the separate `ryankrol.co.uk` repo, re-triggering a build of
that branch's latest commit. WHY: Vercel Deploy Hooks are a documented, unauthenticated,
branch-bound URL — a plain `POST` with no auth header and no body re-triggers a build
(https://vercel.com/docs/deploy-hooks) — and this exists as a safety net because that repo's own
autonomous build harness can push enough commits in a day to exceed Vercel's per-commit auto-deploy
rate limits, silently dropping some deploys; this guarantees the live site is never more than 24h
behind the latest pushed commit regardless. `vercel-redeploy.job.ts` reads
`process.env.VERCEL_DEPLOY_HOOK_URL`: unset soft-skips with a clear WARN log (mirroring
`stock-digest`'s `FINNHUB_API_KEY` soft-skip), set triggers a `POST` with no body/auth header via the
platform's native `fetch` and throws on a non-2xx response or a network error (so a dropped redeploy
shows as a failed run in the dashboard rather than being silently swallowed — the whole point of a
safety net). `timeoutMs: 30_000` (a Deploy Hook POST just enqueues a build, it doesn't wait for the
build itself), `maxRetries: 1`. No `work_items` ledger — pure fire-and-forget trigger, no items to
track, same shape as `claude-warmer`. `category: 'regular-maintenance'`. Runs daily at 23:00
(`'0 23 * * *'`), deliberately late in the day, after a typical day's push activity on
`ryankrol.co.uk`. Provisioning the actual `VERCEL_DEPLOY_HOOK_URL` value requires the owner's Vercel
account access and is tracked as a separate `needs-human` task.
and **plex-space-saver** (`src/jobs/plex-space-saver/`) — a single-stage, report-only audit of where
Plex library disk space is going, distinct from `missing-tv-seasons` (which audits missing seasons,
not disk usage). Reuses the shared plex client (`src/jobs/plex/client.ts`'s `resolvePlexHost`/
`plexGet` — DHCP self-heal, T149) and the existing Plex env (`PLEX_HOST`/`PLEX_API_TOKEN`/optional
`PLEX_MACHINE_ID`), plus the SAME `PLEX_MOVIE_SECTION`/`PLEX_TV_SECTION` env vars the `movies`/
`missing-tv-seasons` workflows already read (no new env vars). Size is obtained via the API — each
Plex `Media.Part` carries a `size` in bytes — never a filesystem walk. Granularity: **one row per
title** — each movie stands alone (its own media parts summed), each TV show is a single row summing
every episode across every season (grouped by `grandparentRatingKey`, mirroring `missing-tv-seasons`'s
`highestOwnedSeasonMap` join pattern). `plex-space-saver-scan` (the only stage — one-stage workflow,
so no DAG edge and no gate is needed per `src/jobs/CLAUDE.md`) fetches the movie section, the TV
section's shows, and its flat episode list (`type=4`), computes a biggest-first breakdown via
`buildMovieRows`/`buildShowRows`/`buildBreakdown` in `lib.ts`, and writes it to
`data/out/size-breakdown.json`. **Report only — never flags or suggests deletions.** RE-SCANS FRESH
every run (an audit, not a build, like `missing-tv-seasons`); idempotent per ISO calendar week via the
`work_items` ledger (`weekKey`, mirrors `stock-digest`) — a manual re-run the same week regenerates
that week's breakdown rather than duplicating it. Runs weekly (Sundays 06:00). **Surfaced via the
T262 declared-output-form mechanism, not markdown prose** — the ledger row's `detail.format:
'size-table'` + `detail.path` point the unified Output section's fetch endpoint
(`resolveOutputForm` in `src/api/server.ts`) at the structured JSON breakdown, served through
`safeOutputFile`; the dashboard's generic `WorkflowOutputSection` renders any form with no dedicated
viewer via its raw-content fallback (`RawOutputBody`), so the structured JSON is visible with no
dashboard changes required. (`detail.markdown` is also set, to the same path, purely so the output
LIST query — `workflowTerminalItems` in `src/db/store.ts`, which gates the "View" button on
`detail.markdown` being truthy and wasn't touched by this task — still surfaces the button; the fetch
endpoint itself dispatches correctly on `detail.format`/`detail.path` regardless.)
Private workflows are added as gitignored subfolders.

Keep it **simple, local, and dependency-light**. This is a personal tool, not a
distributed system. Do not introduce Docker, external databases, message
queues, or cloud infra unless explicitly asked.

## Architecture (how it fits together)

```
launchd ──keeps alive──▶ daemon (src/daemon.ts)
                            │  scheduler (croner) ──schedules──▶ workflow-executor
                            │  HTTP API on :4789                  (orchestrates member
                            │  (manual run ─┐                      jobs in DAG order)
                            │   ─▶ executor)│                            │
                            │               └────────┬───────────────────┘
                            │                        ▼
                            │                     executor ──spawns──▶ child (src/runJob.ts)
                            │                  (single job,              runs ONE job,
                            ▼                   timeout/retries)          emits NDJSON
                         SQLite (data/jobs.db, WAL)  ◀── parent is sole writer
                            ▲
                         dashboard (Next.js, :4788) ── polls the API, read-only
```

- **The daemon is the only long-lived process.** launchd keeps ONE daemon
  alive; the daemon schedules ALL workflows internally (and workflows drive their
  member jobs). Never create one launchd agent per job.
- **Each job runs in an isolated child process** so a hang/crash can't take down
  the daemon, and timeouts can hard-kill it (SIGTERM→SIGKILL).
- **Workflows compose jobs into a DAG — and EVERY job belongs to one.** There are
  no standalone jobs: a lone job is just a one-stage workflow with its own manifest.
  The workflow owns scheduling + the enable toggle; it drives its member jobs. A job
  discovered with no `*.workflow.ts` manifest is a config error and the registry
  **fails loud at load** (the daemon refuses to start). The workflow executor runs
  member jobs in topological order (respecting `dependsOn` edges and bounded
  parallelism) via the same executor. A workflow run is a first-class DB record
  distinct from each member job's own run.
- **Independent stages run in PARALLEL by default (T156).** `executeDag` launches
  every ready stage (deps all succeeded) up to a concurrency cap; `runWorkflow`
  passes the **effective** maxConcurrency (see T169 below) where the default is
  **4** (raised from 1). So a DAG with independent same-wave stages — e.g. the
  `movie-recommendations` `franchise-gaps` + 8 recommender branches all hanging off `movie-snapshot`
  — runs them concurrently (up to 4) once their shared dependency finishes, instead
  of one-after-another. Strictly-linear workflows (places, perfumes, the TV
  `missing-tv-seasons` workflow) are unaffected: only ever one stage is ready at a time. A workflow
  overrides the cap with **`maxConcurrency`** on its `WorkflowDefinition` — raise it
  for a wider fan-out, or set **`1`** to force strict sequential order (the `movie-recommendations`
  workflow sets `4` so its branches fan out; the cap is kept modest because each
  parallel stage spawns its OWN child process, and `executeDag` queues the excess).
  The cap is also **user-editable from the dashboard + code-reconciled (T169)** —
  see the `maxConcurrency` editable-property note in Conventions: `runWorkflow`
  reads the **effective** value (DB `max_concurrency` = override when set, else the
  synced manifest value, else the default) FRESH each run via
  `effectiveWorkflowConcurrency(def)`, so an edit takes effect on the next run with
  no daemon restart.
  Parallelism does NOT loosen spend governance: paid stages still route through
  `callService` → the shared SQLite `service_usage` meter, so rate limits + monthly
  quotas are enforced GLOBALLY across processes regardless of concurrency — the
  service quota is the spend governor, not the cap.
- **The child only emits events; the parent (executor) is the sole DB writer.**
- **A running workflow run is cancellable.** `runWorkflow` registers each run in an
  in-process `workflowRunId → AbortController` map (so BOTH the scheduler and the
  manual `POST /api/workflows/:name/run` path register, since both flow through it)
  and removes it when the run settles. `POST /api/workflow-runs/:id/cancel`
  (mutating — loopback/token guard) looks the run up and `abort()`s it; the signal
  threads `runWorkflow → executeDag → runJobForWorkflow → runAttempts →
  executeAttempt`. On abort the in-flight member's child is **hard-killed**
  (SIGTERM→SIGKILL, reusing the timeout kill path — never just resolving early, which
  would orphan the child), no further stages launch, and the executor (still the sole
  writer) records the workflow run + killed member run `cancelled`. A cancelled member
  is terminal (not retried); not-yet-started stages simply never spawn. Idempotency
  means the next run resumes outstanding work.
- **One active run per workflow (T105).** A given workflow may have only ONE run
  active at a time — but DIFFERENT workflows still run concurrently (this is
  per-workflow, NOT a global lock). The executor is the **authoritative, race-safe
  guard**: `runWorkflow` does a check-and-claim with NO await between them
  (`workflowRunInProgress(name)` → claim `name` in an in-process `startingWorkflows`
  set) BEFORE its first await, so two near-simultaneous starts of the same workflow
  can't both pass — the loser returns `{ skipped: true, reason: 'already running' }`.
  The claim is held for the whole run (released in a `finally`) so the window before
  the DB run row exists (the `await inputKeys()` of a limited run) is also covered.
  `workflowRunInProgress(name) = startingWorkflows.has(name) || hasActiveWorkflowRun(name)`
  — the in-process claim PLUS the DB's `running` check (the latter catches a run still
  going from a prior tick). The API mirrors this: `POST /api/workflows/:name/run`
  returns **409 Conflict** (`{ error: '… already has an active run', running: true }`)
  when `workflowRunInProgress` is true, instead of firing-and-forgetting a 202 that the
  executor would silently skip — so the caller knows it didn't start. The dashboard's
  Run buttons (Workflows LIST + workflow DETAIL) disable and show **"Running…"** while
  `last_run.status === 'running'`, so the UI never lets you click into a duplicate.
- **`repeatUntilStable` cycling stops on no forward progress (T112).** A workflow
  with `repeatUntilStable` re-runs its DAG in cycles until `workflowRetryableCount`
  hits 0 OR a whole cycle advances NOTHING. The framework snapshots the member
  work-item ledger each cycle via `workflowProgressSignature` (row count + summed
  attempts + retryable count); if a cycle leaves the signature unchanged AND the
  retryable count didn't drop (`noForwardProgress`), the loop **breaks early** rather
  than spinning to `maxCycles`. This is the robust fix for a genuinely-unfindable
  input (e.g. a perfume with no Fragrantica page) that is counted "retryable" every
  cycle yet never actually re-attempts/increments — without it EVERY scheduled run
  burned all 40 cycles re-running all stages for nothing. The early stop logs a warn
  telling you to unstick/ignore the stuck item.
- **Workflow notifications are aggregate-only (T189, supersedes T112 per-stage dedup).** `runWorkflow` emits ONLY the aggregate `notifyWorkflow(...)` call at the end of a run — there are NO per-stage push notifications (success, failure, timeout, or cycling). The former `notifyStage` per-stage push and the `lastNotifiedStatus` cycling-dedup map were removed in T189. `notifyStage` still exists in `src/core/notifier.ts` but is no longer called by the executor. The dashboard's per-stage run status is unaffected — member runs still record `running`/`succeeded`/`failed`/`cancelled` to the DB exactly as before.
- **Latest-run-per-stage ordering is rowid-deterministic (T112).**
  `listRunsForWorkflowRun` orders by `(started_at, rowid)`, NOT `started_at` alone.
  `started_at` is second-granularity, so during fast cycling an earlier cycle's
  settled run and the current cycle's fresh `running` run can share a second; without
  the `rowid` tiebreaker the dashboard's last-write-wins "latest per stage" could
  pick the stale settled run over the live one — the succeeded→running→succeeded
  status flicker. Keep any "latest run" derivation ordering by `(started_at, rowid)`.
- **The dashboard is a pure read/refresh client of the API.** It never touches
  SQLite directly and is not required for jobs to run. There are **exactly THREE
  deliberate write exceptions**, all owner-owned overlay files in `.harness/`:
  - **`reviewed` flag (T136, was T124):** lives in `.harness/tracking/reviews.json` (a
    committed `id → { reviewed, at }` map — NOT in TASKS.json, which the loop owns).
    Two endpoints write it: `POST /api/backlog/:id/reviewed` (single task, any
    `reviewed` bool) and `POST /api/backlog/reviewed-bulk { ids: string[] }` (multiple
    tasks reviewed=true in **one** atomic write + **one** git commit). Both atomically
    write the file (temp-file + rename) AND, under the SAME mkdir lock loop.sh uses
    (`src/core/repo-lock.ts`), commit it `[skip ci]` + push to GitHub (fetch+rebase+
    retry; a failed push is a non-fatal warning). The bulk endpoint produces exactly ONE
    git commit for the whole batch — the Backlog UI uses it for the select-all/bulk
    flow (T191).
  - **`done` flag (T208):** lives in `.harness/tracking/human-done.json` (a committed
    `id → { done: true, at }` map). `POST /api/backlog/:id/done` applies only to
    tasks with `gate === 'needs-human'` (400 otherwise); it atomically writes the
    file and commits+pushes under the same repo lock. **Marking done implies
    reviewed**: `GET /api/backlog` overlays `done=true` and derives `reviewed=true`
    for any human-done task. The dashboard/API write ONLY the overlay; the loop then
    RECONCILES it → `TASKS.json` `status=done` at pre-flight (T261, `reconcile_overlays`
    in `loop.sh`), so a needs-human blocker marked done actually unblocks its dependents
    (the loop keys selection on `TASKS.json` status, not the overlay). The Backlog page
    shows a **"Mark done"** button on needs-human tasks that aren't already done.
  - **`failed` flag (manual-fail-signal):** lives in `.harness/tracking/manual-fail.json` (a
    committed `id → { failed: true, reason, at }` map). `POST /api/backlog/:id/failed`
    is the owner's "this DONE task actually failed" correction — it applies only to
    `status === 'done'` tasks (400 otherwise) and requires a `reason`; `{ failed: false }`
    undoes. Same atomic write + commit/push-under-repo-lock pattern. **Marking failed
    implies reviewed**: `GET /api/backlog` overlays `failed=true` + `failReason` and
    derives `reviewed=true`. Crucially this is NOT just display — the **loop READS this
    overlay** (the only overlay it reads) to CORRECT calibration: a falsely-recorded
    success is re-counted as a failure for difficulty tuning AND dropped from its
    `(layer×workType)` cell's confirmed-audited count, so that category is built with a
    stronger model and audited more often. The dashboard/API write ONLY the overlay; the
    loop then RECONCILES it → `TASKS.json` `status=failed` at pre-flight (T279,
    `reconcile_overlays`) — an authoritative TERMINAL status the loop skips (it does NOT
    re-open/rebuild; the re-do is a separate follow-up task). The Backlog page shows a
    **"Mark failed"** button on done tasks — the sole interface to this overlay (a
    portable, no-dashboard `mark-failed.sh` script + `/local-jobs-mark-task-failed` command
    used to exist alongside it; both were removed since every project this harness runs
    in now has a dashboard — see "Known-but-deferred issues" if portability is needed
    again). Full design: `.harness/docs/designs/manual-fail-signal.md`.
  All three overlay files are disjoint git paths from TASKS.json and from each other,
  so no writer ever conflicts with the loop or another file. The dashboard/API still
  write ONLY the overlays and NEVER touch TASKS.json — the decoupling holds. The loop is
  the sole TASKS.json writer: at pre-flight it READS the `human-done`/`manual-fail`
  overlays and RECONCILES their verdicts into `TASKS.json` `status` (done / failed)
  (T261/T279, `reconcile_overlays` in `loop.sh`), so the overlays are the owner's
  write-surface and `TASKS.json` status is the authoritative reconciled state.
- **A `status="blocked"` task is the LOOP's own failure signal — distinct from the owner's
  `status="failed"` above, and NOT an overlay.** When `block_task()` (in `loop.sh`) gives up on
  a task (either the agent itself reports `failed:blocked` mid-attempt, or `MAX_ATTEMPTS` is
  exhausted at the top model tier), it writes the usual `failed:blocked <id> — <reason>` worklog
  marker AND now also calls `set_task_status "$id" blocked` directly — the loop already
  unconditionally owns `TASKS.json` `status`, so this needs no overlay/reconcile indirection
  (that indirection exists only because the *dashboard* isn't allowed to write `TASKS.json`
  directly; the loop has no such restriction on itself). `blocked` is terminal for selection
  (`task_blocked()` in `loop.sh`/`postflight.sh` checks `status=="blocked"` first, falling back
  to the legacy worklog-marker grep for tasks blocked before this existed — never backfilled,
  so both paths are kept). **Calibration was already correctly aligned even before this status
  existed:** `policy.jq`'s tier-selection branch already treats a `blocked:true` outcome row
  exactly like an owner manual-fail (`(.blocked or (manual-fail id)) as $failed`), and
  `audit_gate()`'s confirmed-audited-success count already required `.blocked==false` — a
  blocked row was never counted as a success to begin with. So `status="blocked"` is purely a
  **visibility** upgrade (dashboard-queryable the same way `failed` is), not a new calibration
  mechanism.

## File map

| Path | Responsibility |
|---|---|
| `src/config.ts` | Env-driven config: ports, bind host, CORS allowlist, auth token, db path, ntfy, shared Chrome profile dir |
| `src/daemon.ts` | Long-lived entrypoint: sync jobs + workflows, reap orphans, start scheduler + API |
| `src/runJob.ts` | Child entrypoint: run one job, emit NDJSON |
| `src/core/types.ts` | `JobDefinition`, `WorkflowDefinition`, `ServiceDefinition`, `JobContext`, event types — the contracts |
| `src/core/executor.ts` | Spawn child, parse events, enforce timeout, retries, overlap-prevention; **cancellation** — an `AbortSignal` threaded into the attempt loop hard-kills the in-flight child (SIGTERM→SIGKILL, the timeout path) and settles the run `cancelled` (terminal, never retried) |
| `src/core/scheduler.ts` | croner triggers for scheduled **workflows** (the only schedule owner; drives member jobs — jobs never get their own cron); respects `enabled`; registers each cron from the **effective** (DB) schedule, and `rescheduleWorkflow(name, schedule)` re-registers it LIVE after a dashboard edit — no restart (T135) |
| `src/core/dag.ts` | Workflow DAG: build + validate topological order, cycle detection; `executeDag` honours an `AbortSignal` (stops launching new stages, drains in-flight) |
| `src/core/workflow-executor.ts` | Orchestrate a workflow run: member jobs in DAG order, stage gates, retries, completed-stage progress roll-up; `repeatUntilStable` cycling with a **no-forward-progress early stop** (T112, via `workflowProgressSignature`/`noForwardProgress`); owns the **active-run registry** (`workflowRunId → AbortController`) + `cancelWorkflowRun()` that powers run cancellation; the **authoritative "one active run per workflow" guard** — `workflowRunInProgress(name)` + a synchronous per-name claim in `runWorkflow` (see below); emits ONLY the aggregate `notifyWorkflow` at run end (no per-stage pushes — T189) |
| `src/core/notifier.ts` | Run alerts (success/failure/timeout) with item counts + stuck heads-up: ntfy push + macOS notification. `notifyWorkflow` is called once per workflow run at completion (aggregate). `notifyStage` is exported but no longer called by the executor (T189) |
| `src/core/services.ts` | `callService`: cross-job shared rate-limit + quota middleware (coordinated via SQLite) |
| `src/core/browser.ts` | Shared headless-browser helper: persistent-profile + real-Chrome-channel launch (bundled-chromium fallback, stale-lock cleanup) for reputation-gated scrapes, plus a jittered-delay pacing helper |
| `src/core/repo-lock.ts` | The shared mkdir-based repo lock (`acquireRepoLock`/`resolveRepoPaths`) the daemon's reviews commit+push uses to be mutually exclusive with the autonomous loop (T136). The lock path MUST stay byte-identical to `loop.sh`'s `acquire_lock` (`<git-common-dir>/<basename(repo-root)>-loop.lock` + `pid` file + stale-pid reclaim) |
| `src/db/schema.sql` | `jobs`, `runs`, `run_logs`, `work_items` (+ `root_key`/`parent_key` lineage), `work_item_runs` (run→work-item attribution, T139), `job_usage`, `workflows`, `workflow_jobs`, `workflow_runs` (+ `run_limit`/`selected_roots`), `workflow_run_logs`, `services`, `service_usage`, `service_consumers` (runtime-recorded job→service mapping, T186) |
| `src/db/index.ts` | SQLite connection + schema bootstrap (WAL mode) |
| `src/db/store.ts` | ALL queries live here — add new ones here, not inline |
| `src/jobs/registry.ts` | Auto-discovers `*.job.ts` + `*.workflow.ts` under `src/jobs/` AND `*.service.ts` under BOTH `src/services/` and `src/jobs/` (no manual registration); fails loud if any job belongs to no workflow (`orphanJobNames`) |
| `src/services/*.service.ts` | **Top-level, daemon-wide** service definitions, default-exporting a `ServiceDefinition` (shared rate-limited / quota'd dependencies — gemini, google-places, fragrantica, claude-cli). **Self-contained**: each owns its limits from env and imports NOTHING from a workflow |
| `src/services/lib.ts` | Shared service spend-cap math: `DAILY_SPEND_DIVISOR` (=30) + `dailyFromMonthly()` — the `daily = monthly/30` rule for paid daily-scheduled services |
| `src/services/claude.ts` | Shared, self-contained Claude Code CLI helper (`runClaude`/`extractJsonObject`) — gates every call through the `claude-cli` service, reads `LOCALJOBS_CLAUDE_BIN`/`_TIMEOUT_MS` from env. Used by the movies recommender branches (T146). (Perfumes still has its own `perfumes/claude.ts` — migrating it onto this is a follow-up; see `.harness/docs/LIMITATIONS.md`.) |
| `src/jobs/<workflow>/` | One folder per example workflow (`places/`, `perfumes/`, `plex/`, `movies/`, `tv-recs/`, `workouts-sync/`, `listening-digest/`, `projects-sync/`, `claude-warmer/`, `stocks-sync/`, `stock-digest/`, `vercel-daily-redeploy/`, `plex-space-saver/`). Shared files at the JOB ROOT (`*.workflow.ts`, `config.ts`, `types.ts`, `contracts.ts`, helpers like perfumes `lib.ts`/`claude.ts` + places `parse.ts`, the template, `data/`); per-stage code grouped under a flat `stages/` subfolder |
| `src/jobs/tv-recs/` | TV show recommendations workflow. `tv-recs.workflow.ts` (monthly schedule, maxConcurrency 4); `config.ts` / `types.ts` / `lib.ts` / `recs.ts` (pure recommendation helpers); `stages/tv-snapshot.job.ts` + `tv-snapshot.ts` (Plex TV snapshot → `snapshot.json` + `taste-profile.json`); `stages/tv-rec-*.job.ts` (8 branch jobs); `stages/tv-rec-merge.job.ts` + `tv-rec-merge.ts` (TMDB-verify/dedupe/balance/top-up → `recommendations.json`); `stages/tv-recs-notify.job.ts` + `tv-recs-notify.ts` (monthly digest + report → `data/out/reports/tv-recommendations.md`). Reuses `src/jobs/plex/client.ts` for Plex connectivity. |
| `src/jobs/<workflow>/stages/*.job.ts` / `*.ts` | One stage per `<stage>.job.ts` (default-exports a `JobDefinition`) + its `<stage>.ts` impl (+ `<stage>.test.ts`). Root-level top-level `*.job.ts` files are gitignored; the `places/`+`perfumes/` stages are tracked |
| `src/jobs/*.workflow.ts` | Workflow manifests, default-exporting a `WorkflowDefinition` (DAG of jobs); live at the job-folder root |
| `src/api/server.ts` | Node `http` API (no framework). Add routes here |
| `dashboard/app/*` | Next.js App Router dashboard (client components, poll via `app/lib/api.ts`); all responsive CSS lives in `app/globals.css` |
| `dashboard/scripts/_dashboard-harness.mjs` | Shared hermetic test harness (the SINGLE living artifact): `PAGES` list + synthetic API fixtures + `next start` spawn + `/api/**` interception + theme seeding; imported by both checks below. Update it when the UI surface changes |
| `dashboard/scripts/mobile-check.mjs` | Hermetic phone-viewport (402px) styling check — overflow/box-spill; local only, not in CI |
| `dashboard/scripts/visual-check.mjs` | Hermetic desktop-viewport SCREENSHOT capture for visual confirmation (the thing actually renders) — writes PNGs to the gitignored `visual-out/`; no appearance assertions; local/loop only, not in CI |
| `scripts/*` | launchd install scripts + start wrapper |

## How to add a job (the common request)

**Every job must belong to a workflow** — there are no standalone jobs. A lone job
is a one-stage workflow with its own `*.workflow.ts` manifest (no implicit
wrapping). The workflow owns the `schedule`; a job with no manifest fails loud at
load.

1. Create `src/jobs/<name>.job.ts`:
   ```ts
   import type { JobDefinition } from '../core/types.js';

   const job: JobDefinition = {
     name: 'unique-name',           // stable; it's the DB primary key
     description: 'what it does',
     timeoutMs: 600_000,            // 0 = no timeout
     maxRetries: 3,
     async run(ctx) {
       ctx.log('message');          // -> run_logs, shown live in dashboard
       ctx.progress(50, 'halfway'); // -> progress bar 0..100
       // ...work... throw to fail the run
     },
   };
   export default job;
   ```
   A job carries NO workflow-level properties (T070): no `schedule`, no `enabled`
   toggle, no `instructions`, and no run-now — those live ONLY on the workflow. The
   `JobDefinition` is just identity + execution params (`timeoutMs`/`maxRetries`) +
   `run`/`produces`/`consumes`. You run a WORKFLOW, never a job; a job runs when its
   prerequisites are met inside its workflow, and `/jobs/[name]` is a read-only
   member view (status · run history · logs). Put any setup/run docs in the README,
   not on the job.
2. Declare it in a `*.workflow.ts` manifest — a one-stage workflow for a lone job;
   the workflow carries the cron `schedule` (or `null` for manual-only):
   ```ts
   import type { WorkflowDefinition } from '../core/types.js';

   const workflow: WorkflowDefinition = {
     name: 'unique-name',           // distinct from every job name
     description: 'what it does',
     schedule: '0 3 * * *',         // croner cron, or null for manual-only
     jobs: [{ job: 'unique-name' }],
   };
   export default workflow;
   ```
3. That's it for wiring — jobs and workflows are **auto-discovered** by filename
   glob (`*.job.ts` / `*.workflow.ts`). There is **no registry to edit**.
4. Tell the user to restart the daemon (jobs are loaded at startup):
   `launchctl kickstart -k gui/$(id -u)/com.ryankrol.localjobs`

**Multi-stage workflow layout (the example folders).** A workflow folder keeps its
shared files at the JOB ROOT (`*.workflow.ts`, `config.ts`, `types.ts`,
`contracts.ts`, any helper modules + the template + `data/`) and groups its
per-stage code under a flat `stages/` subfolder — one `<stage>.job.ts` +
`<stage>.ts` impl (+ `<stage>.test.ts`) per stage. **Adding a new stage** = drop
its files in `<workflow>/stages/` and add the member to the `*.workflow.ts` — jobs
are discovered **recursively**, so a `*.job.ts` in `stages/` is picked up
automatically. A stage file imports root-level shared modules one level up
(`../config.js`, `../types.js`, `../contracts.js`, …) and framework code two more
(`../../../core/…`, `../../../db/…`); sibling stages stay `./`. Keep config/data
resolution (`resolve(here, …)`) anchored at the job root, so `config.ts`/`data/`
stay at the root, not in `stages/`.

**Adding a service** = create `src/services/<name>.service.ts` (top-level,
daemon-wide), default-exporting a self-contained `ServiceDefinition` that reads its
own limits from env and imports nothing from any workflow. The registry discovers
it from `src/services/` automatically (it also still scans `src/jobs/` so a private
job MAY colocate a service it owns).

> **Privacy — real jobs are local-only by default.** Top-level
> `src/jobs/*.job.ts` files are gitignored. The
> public repo ships the `places/`, `perfumes/`, `plex/`, `movies/`, `tv-recs/`, `workouts-sync/`, `listening-digest/`, `projects-sync/`, `claude-warmer/`, `stocks-sync/`, `stock-digest/`, `vercel-daily-redeploy/`, and `plex-space-saver/` subfolder workflows as
> worked examples, but their `data/` folders stay gitignored. New jobs you add as
> a root-level `*.job.ts` stay untracked by design. NEVER use `git add -f` on a
> private job file.
>
> For a **new private multi-file workflow**, create `src/jobs/<name>/` and add the
> line `src/jobs/<name>/` to `.gitignore`. Jobs are discovered **recursively**,
> so a `*.job.ts` inside that folder is picked up automatically while its helper
> modules stay private too.

### Job conventions
- Jobs must be **idempotent / safe to re-run** (they retry and can be run
  manually). Use guards / "skip if already done".
- Use `ctx.log` and `ctx.progress` generously — that's the entire visibility
  story. No `console.log` (it still gets captured, but prefer `ctx`).
- **Item-loop jobs report progress per item, not just at the end.** Any job that
  processes N items must call `ctx.progress(i/N*100)` and log an `i/N` line as it
  finishes each one, so the job's own run % advances live (the workflow bar only
  steps when the whole stage finishes — see the progress roll-up note below)
  instead of jumping 0→100 at the finish. Use a sensible denominator — the count
  it will actually attempt this run (e.g. `Math.min(todo.length, runLimit)`). The
  perfumes stages share `reportItemProgress(ctx, done, total, suffix?)` in
  `perfumes/lib.ts` for this; the places stages emit it inline. All 8 example-job
  loops do this — match it in new jobs.
- Keep secrets in `.env` (read via `process.env`); never hardcode. The child
  inherits the daemon's env.
- **Record a produced markdown artifact's path in the work item's `detail.markdown`
  (T110).** A job whose final output is a markdown file should pass the file's
  absolute path as `markWorkItem(…, { detail: { name, markdown: mdPath } })`
  (places-llm-enrich and perfumes-build both do). The dashboard's workflow-run
  **Input → Output** panel reads it via `workItemMarkdownPath` and the read-only,
  path-safe `GET /api/workflow-runs/:id/output?job=&key=` endpoint to preview the
  artifact + open the full markdown in a popover. The popover renders content as
  formatted markdown via `react-markdown` (XSS-safe — no `rehype-raw`, raw HTML is
  escaped not executed; T115). YAML frontmatter is stripped and shown as a compact
  key-value header. The endpoint confines reads to a `.md` file inside a job's own
  `data/out/` tree (`safeOutputMarkdown` in `server.ts` — resolve + realpath +
  prefix + `/data/out/` checks; no traversal, files only, no paid/remote calls),
  so keep output artifacts under `data/out/`.
- **Unified Output section on the workflow detail page (T205).** Every workflow's detail
  page shows a consolidated **Output** section backed by `GET /api/workflows/:name/output-items`
  → `workflowTerminalItems(lastWave)` in `src/db/store.ts`. The convention is:
  - **The terminal stage's `work_items` ledger IS the output list.** `workflowTerminalItems`
    queries `work_items` for the DAG's final-wave job names with `status='success'`, ordered
    newest first. Items are de-duped by `(job_name, item_key)` by construction (the ledger has
    a UNIQUE key per pair), so each produced item appears exactly once regardless of how many
    runs have processed it.
  - **Markdown artifact workflows** (places, perfumes): the terminal stage records
    `detail: { name, markdown: <path> }` on each `markWorkItem` call (T110). The output
    section shows a "View" button per item that fetches `GET /api/workflows/:name/output?job=&key=`
    (same guard as the per-run endpoint: `safeOutputMarkdown`, confined to `data/out/` tree)
    and opens the content in a markdown popover.
  - **Audit-style workflows** (movie-recommendations, missing-tv-seasons): these already have
    dedicated, richer output managers (`MovieRecsManager`, `MovieGapsManager`,
    `MissingSeasonsManager`) on the detail page. They are EXCLUDED from the generic section
    (the `WORKFLOWS_WITH_SPECIFIC_MANAGERS` set in `page.tsx`). New dedicated managers should
    be added to that set; standard build workflows use the generic section automatically.
  - **Adding a new workflow that produces output**: make the terminal stage call
    `markWorkItem(ctx, key, 'success', { detail: { name: ..., markdown: <path> } })` for
    markdown artifact items, OR just `markWorkItem(ctx, key, 'success')` for non-markdown
    items. The output section renders automatically — no extra wiring needed.
  - **`outputJob` override for a non-terminal output stage (T348).** Some workflows are
    shaped build-then-notify, where the DAG's TERMINAL stage is a pure notify-trigger that
    structurally never records `work_items` rows (e.g. `stocks-sync`'s `stocks-notify`, which
    just reads `fresh-breaches.json` and optionally sends one push) — for these the generic
    Output section would always be empty even though a real, meaningful ledger exists one
    stage earlier. `WorkflowDefinition.outputJob` (an optional field on the manifest, like
    `category`) names a different member job whose ledger the Output section should read
    instead; `GET /api/workflows/:name/output-items` uses it (falling back to the terminal
    wave if unset or if the name isn't an actual member) in place of `lastWave`. It's
    opt-in and manifest-owned only — no dashboard edit UI, no `_overridden` column, same as
    `category`.
  - **Output-form convention (T262) — how to add a new render form.** An output
    item declares its render form via `detail.format` (a string, defaults to `"markdown"`
    when absent). The read-only output endpoint (`GET /api/workflow-runs/:id/output` and
    `GET /api/workflows/:name/output`) dispatches on `detail.format` and serves the file
    through the matching safety guard — both guards confine reads to the job's own
    `data/out/` tree, so all forms inherit the same path-safety properties:
    - **`markdown` (default)**: the path comes from `detail.markdown`; served via
      `safeOutputMarkdown` (must end in `.md`). Existing places/perfumes outputs use
      this form with no change — `detail.format` is optional for backward compat.
    - **Any other form** (e.g. `"json"`, `"table"`): the path comes from `detail.path`;
      served via `safeOutputFile` (any extension allowed, same `data/out/` + realpath
      guards). The response payload includes `format` so the dashboard renderer
      (T282) can dispatch to the right viewer.
    - **To add a new form**: record `{ name, format: '<key>', path: <absPath> }` in
      `detail` via `markWorkItem`; the API serves it automatically. The renderer
      dispatch (T282) then adds a viewer for `<key>` in the dashboard — no endpoint
      changes needed. Keep output files under `data/out/` (the guard rejects anything
      outside that tree).
- Long jobs: set a realistic `timeoutMs` so a hang is killed, not left forever.
- Heavy external calls (Places API, headless browser): rate-limit inside the
  job, and make progress observable.

## Logging — be verbose by default

**Always prefer the most verbose logging you can get away with. Err on
over-logging, never under-logging.** Storage is not a concern — kilobytes of
logs per run is completely fine.

Every job should narrate itself through `ctx.log()` so its run page tells the
full story without anyone reading the code:
- What it's about to do, and the config/paths/inputs it's using.
- Each meaningful item as it's processed (per-list, per-record), not just totals.
- Every decision: skips, merges, dedupes, retries, fallbacks — and *why*.
- A detailed final summary: totals, per-category breakdowns, notable items
  enumerated, where output was written, and the validation result.

Use levels (`info` / `warn` / `error`) so the dashboard can colour them. When in
doubt, log it.

## Conventions
- TypeScript, ESM, **NodeNext** — always use `.js` extensions in relative
  imports (e.g. `import { x } from './foo.js'`), even for `.ts` files.
- **Every job belongs to a workflow — no standalone jobs.** A job must be a member
  of a workflow declared in a `*.workflow.ts` manifest (a lone job = a one-stage
  workflow with its own manifest; there is no implicit wrapping). The workflow owns
  scheduling + the enable toggle and drives its members — a job never gets its own
  cron. The registry enforces this at load via `orphanJobNames` and **throws** (the
  daemon refuses to start) if any discovered job has no workflow. When you add a
  job, add its manifest in the same change.
- **A workflow's `schedule` is user-editable + code-reconciled (T135).** Like the
  `enabled` toggle and the editable service limits, the cron `schedule` is
  **user-owned**: `POST /api/workflows/:name/schedule { schedule }`
  (`updateWorkflowSchedule` in `store.ts`) persists an override and flips
  `schedule_overridden = 1`, so a later `syncWorkflow` PRESERVES it
  (`schedule = CASE WHEN schedule_overridden = 1 THEN schedule ELSE excluded.schedule END`
  in `upsertWorkflowStmt`) instead of reverting to the manifest value. An empty/blank
  value clears it to `null` = manual-only. The scheduler registers each cron from the
  **EFFECTIVE** (DB) schedule — override when set, else the synced code default — and
  `rescheduleWorkflow(name, schedule)` re-registers the live `Cron` after an edit so it
  takes effect **without a daemon restart** (mirroring the fire-time `enabled` check).
  The API VALIDATES the cron server-side (`new Cron(expr, { paused: true })`) and
  rejects an invalid expression with **400** before it ever reaches the scheduler;
  it's a mutating endpoint behind the same loopback/token guard as `/toggle`, `/run`,
  `/limits`. `schedule_overridden` is added by `schema.sql` (fresh DBs) + an additive
  `ALTER TABLE` migration in `index.ts` (existing DBs, per the T098 rule).
- **A workflow's `maxConcurrency` is user-editable + code-reconciled (T169).** The
  bounded-parallelism cap (T156) joins `schedule` + `enabled` + service limits as a
  user-owned, override-flagged, code-reconciled workflow property — same mechanism
  end-to-end. `POST /api/workflows/:name/concurrency { maxConcurrency }`
  (`updateWorkflowConcurrency` in `store.ts`) persists the value and flips
  `max_concurrency_overridden = 1`, so a later `syncWorkflow` PRESERVES it
  (`max_concurrency = CASE WHEN max_concurrency_overridden = 1 THEN max_concurrency ELSE excluded.max_concurrency END`
  in `upsertWorkflowStmt`) instead of reverting to the manifest value; the manifest's
  `maxConcurrency` SEEDS `max_concurrency` on sync (a non-overridden value still
  refreshes from code). `runWorkflow` reads the **EFFECTIVE** value
  (`effectiveWorkflowConcurrency(def)` = DB `max_concurrency` ?? `def.maxConcurrency`
  ?? `DEFAULT_WORKFLOW_CONCURRENCY`) FRESH each run, so an edit takes effect on the
  **next run without a daemon restart** (mirroring the fire-time schedule/enabled
  checks). The API VALIDATES it server-side (positive integer ≥ 1, else **400**)
  before it reaches the store and exposes `effective_max_concurrency` on the
  `GET /api/workflows/:name` payload for the detail page's editable "Max concurrency"
  row (number input + Save, like Schedule); it's a mutating endpoint behind the same
  loopback/token guard as `/toggle`, `/run`, `/schedule`, `/limits`. The
  `max_concurrency` + `max_concurrency_overridden` columns are added by `schema.sql`
  (fresh DBs) + an additive `ALTER TABLE` migration in `index.ts` (existing DBs, per
  the T098 rule — no index on the new columns).
  **Unlimited (no cap, T201).** Setting `maxConcurrency = 0` (the
  `UNLIMITED_CONCURRENCY_SENTINEL`) expresses "no concurrency cap — launch ALL ready
  stages together". The API accepts `0` alongside ≥1 (still rejects negatives/garbage
  with **400**); `updateWorkflowConcurrency` in `store.ts` allows `0`; and
  `effectiveWorkflowConcurrency` maps `0 → Infinity` so `executeDag` skips the slot
  check entirely. The dashboard's "Max concurrency" editor exposes an explicit
  **Unlimited** checkbox — when checked, `0` is persisted and the read view shows
  "Unlimited" instead of a number. `effective_max_concurrency = 0` in the API payload
  signals the unlimited state to the UI (Infinity cannot serialise as JSON).
- **A workflow's push notifications are user-editable + code-reconciled (T285).**
  Whether the run-end aggregate push notification (T189) fires joins `schedule` +
  `maxConcurrency` + `enabled` + service limits as a user-owned, override-flagged,
  code-reconciled workflow property — same mechanism end-to-end, binary on/off only
  (no per-status "only notify on failure" mode). `POST /api/workflows/:name/notify
  { notifyEnabled }` (`updateWorkflowNotifyEnabled` in `store.ts`) persists the value
  and flips `notify_enabled_overridden = 1`, so a later `syncWorkflow` PRESERVES it
  (`notify_enabled = CASE WHEN notify_enabled_overridden = 1 THEN notify_enabled ELSE
  excluded.notify_enabled END` in `upsertWorkflowStmt`) instead of reverting to the
  manifest value; the manifest's `notifyEnabled` (default `true`) SEEDS
  `notify_enabled` on sync. `runWorkflow` reads the **EFFECTIVE** value
  (`effectiveWorkflowNotifyEnabled(def)` = DB `notify_enabled` ?? manifest
  `notifyEnabled` ?? `true`) FRESH each run and gates ONLY the single T189 aggregate
  `notifyWorkflow(...)` call at the end of `runWorkflowInner` (not per-stage — there
  are none since T189) — when disabled it logs a clear "Notifications disabled…"
  line instead so the run's own log still narrates why no push went out. An edit
  takes effect on the **next run without a daemon restart**. The API VALIDATES the
  body is a boolean (else **400**) before it reaches the store and exposes
  `effective_notify_enabled` on the `GET /api/workflows/:name` payload for the
  detail page's click-to-toggle "Notifications" row (same affordance as the
  `enabled` toggle — no Save button); it's a mutating endpoint behind the same
  loopback/token guard as `/toggle`, `/run`, `/schedule`, `/concurrency`, `/limits`.
  The `notify_enabled` + `notify_enabled_overridden` columns are added by
  `schema.sql` (fresh DBs, default `1` = ON) + an additive `ALTER TABLE` migration in
  `index.ts` (existing DBs, per the T098 rule — no index on the new columns).
- **A workflow's `category` is manifest-owned only — no dashboard edit UI (T292).**
  Unlike `schedule`/`maxConcurrency`/`notifyEnabled`, `category` is a pure grouping
  label for the workflows-list page with NO `_overridden` column and NO edit
  endpoint: `syncWorkflow` always refreshes it from the manifest's `category` field
  on every sync (same as `description`), so there is nothing for the owner to
  override. Controlled values in use: `second-brain` (places, perfumes),
  `recommendations` (movie-recommendations, tv-recommendations,
  missing-tv-seasons), and `regular-maintenance` (workouts-sync, listening-digest,
  projects-sync, claude-warmer, stocks-sync). A manifest with no `category` set
  defaults to `'uncategorized'`. The `category` column is added by `schema.sql`
  (fresh DBs, `NOT NULL DEFAULT ''`) + an additive `ALTER TABLE` migration in
  `index.ts` (existing DBs, per the T098 rule — no index on the new column).
- **Per-workflow "Clear output data" reset action (T203).** `POST /api/workflows/:name/reset-output`
  (mutating — loopback/token guard, refuses with **409** while a run is active) wipes all
  output state for a workflow so it re-processes from scratch on the next run.
  **What is cleared:** `work_items` + `work_item_runs` (the per-item ledger), `run_logs` +
  `runs` (all member job run history), `workflow_run_logs` + `workflow_runs` (all workflow run
  history), and the contents of the workflow's `data/out/**` directory (output files only —
  NOT the `data/out` directory itself, which is left in place).
  **What is preserved:** `data/raw/**` (input data), `data/chrome-profile/`, `.env`, the
  definition tables (`workflows`, `jobs`, `workflow_jobs`), all user-owned settings
  (`enabled`, schedule override, concurrency override, service limit overrides), and
  `service_usage` (the spend meter — lifetime call counts are never erased).
  The filesystem cleanup (`findWorkflowDataOut` + `deleteDataOutContents` in `server.ts`)
  locates the workflow's folder by scanning `JOBS_ROOT` for `*.workflow.ts` files and
  dynamically importing each to match by `default.name` (fast — already in module cache after
  registry startup). Two path-safety guards in `deleteDataOutContents` enforce that the target
  is (1) within `JOBS_ROOT` AND (2) contains `/data/out/` in its path — neither check alone
  is sufficient. The DB reset (`resetWorkflowOutput` in `store.ts`) uses subquery-based deletes
  (`DELETE … WHERE run_id IN (SELECT id FROM runs WHERE job_name IN (…))`) to avoid SQLite's
  999-variable limit. The dashboard's workflow detail page exposes a **Danger zone → Clear
  output data** button (disabled while a run is active, confirms via the browser native dialog
  before posting) and shows a green success line or red error message after the call.
- **No workflow-level properties on a job (T070).** Because a job is only ever a
  workflow member, ALL workflow-level concerns live on the workflow, never the job:
  a job has NO `schedule`, NO `enabled` toggle, NO `instructions`, and NO run-now.
  There is no `POST /api/jobs/:name/run` or `/toggle`, no per-job scheduling, and
  the `jobs` table has no `schedule`/`enabled` columns (dropped by the
  `migrateDropJobColumns` migration in `src/db/index.ts`). `/jobs/[name]` is a
  read-only MEMBER view (status · run history · logs); you run + enable a WORKFLOW.
  Don't add any of these back to `JobDefinition` or the job page.
- All SQL goes through `src/db/store.ts`. Don't scatter `db.prepare` calls.
- **Schema bootstrap must NEVER reference a migration-added column (T098).**
  `openDb()` (in `src/db/index.ts`) runs `db.exec(schema.sql)` FIRST, then the
  additive migrations. On a **fresh** DB `schema.sql`'s `CREATE TABLE` already
  carries every column, so a bootstrap `CREATE INDEX … ON t(new_col)` works — but
  on an **existing** DB the column is only added by a LATER `ALTER TABLE` in a
  migration, so that same bootstrap index throws `no such column` and crash-loops
  the daemon at startup (the T094 regression, fixed in 2748c58). **Rule:**
  `schema.sql` must NOT create an index/constraint on a column that an additive
  migration adds — put such an index INSIDE the migration, AFTER its `ALTER TABLE`
  (see `migrateRunLimitLineage` in `src/db/index.ts`: it ALTERs in `root_key`,
  backfills, then `CREATE INDEX … idx_work_items_root`). The unit suite can't catch
  this on its own because it always starts from a fresh scratch DB; the regression
  guard `src/db/migrate-existing-db.test.ts` runs the REAL `openDb(path)` against a
  pre-seeded OLD-shape DB (tables/rows lacking the newer columns) and asserts it
  doesn't throw and ends correctly migrated — it FAILS if pointed at the pre-fix
  buggy `schema.sql`. (`openDb(dbPath?)` takes an optional path solely so this test
  can drive it; the daemon uses the default.)
- **Idempotency — per-item work ledger (the standard).** For jobs that process
  many items, record each item's outcome in the `work_items` SQLite table via
  `src/db/store.ts` (`isWorkItemDone`, `markWorkItem`, `workItemCounts`), keyed by
  `(jobName, itemKey)`. Re-runs skip items already done (success, manually
  `ignored`, or failed past `maxAttempts`) so work is never reprocessed. The whole places workflow uses this
  (resolver by CID, enrich + LLM by place_id); the rich output still goes to the
  job's `data/` files — the ledger just tracks *what's done*. Don't use ad-hoc
  "skip if it's in the JSON file" checks.
  - **Variant — "re-scan + notification-log" idempotency (the `missing-tv-seasons`
    workflow, T144; folder `src/jobs/plex/`).** Some workflows have NO static input list to skip-against: their inputs
    are DISCOVERED live each run (the plex audit re-reads the whole Plex library +
    re-checks TMDB every time). Such a workflow **declares no `inputKeys()`** (so it
    is NOT limitable — scheduled-only, always unlimited) and its scan/check stages
    deliberately **re-compute fresh every run** (no skip-if-done). Idempotency then
    lives ONLY in the FINAL stage, which uses the `work_items` ledger not as a
    "work-done" log but as a **"have I already notified this?" log**: it keys each
    actionable result `(notify-job, "<id>::S<n>")`, treats rows NOT yet `success` as
    newly-detected, sends ONE digest of just those, and marks them done so each is
    announced exactly once (first run = the whole current backlog). Record ledger
    rows ONLY for actionable items so the IO panel highlights those, not the 600+
    "up to date" rows. Same-key stages → `root_key = item_key` naturally (no lineage
    args). Use this shape when the work is a periodic audit/alert, not a build.
  - **Plex client self-heals a changed DHCP IP (T149).** The owner's Plex server
    gets its IP via DHCP, so a hardcoded `PLEX_HOST` goes stale and used to break
    the whole workflow at the snapshot stage. `src/jobs/plex/client.ts` resolves the
    base URL via a cached `resolvePlexHost()` (resolve at most once per daemon run;
    `plexGet` uses the result, not `plexConfig.host` directly): it first confirms the
    configured `PLEX_HOST` is a live Plex by GETting `/identity` (and, when
    `PLEX_MACHINE_ID` is set, that the returned `machineIdentifier` matches — so it
    never latches onto a different Plex), and otherwise **scans the local IPv4 /24
    subnet(s)** (from `os.networkInterfaces()`) probing each host on `:32400` at
    `/identity` (http + https via the existing scoped `rejectUnauthorized:false`
    agent — never a global TLS disable), bounded by per-probe timeout + concurrency +
    an overall wall-clock cap so a no-Plex LAN fails fast. On a scan hit it logs
    "found Plex at <host> — set PLEX_HOST …"; when nothing answers it throws the clear
    "set PLEX_HOST" error. The network probe is **injectable** (`PlexProbe`) so a
    hermetic test (`plex.test.ts`) covers configured-wins / scan-fallback /
    machine-id-match / caching / not-found without a network. `PLEX_MACHINE_ID` is
    optional but documented in `.env.example` (it makes the scan safe).
  - **Run→work-item attribution (`work_item_runs`, T139).** `work_items` stays the
    CUMULATIVE, idempotent ledger keyed by `(job_name, item_key)` with NO run
    linkage. The separate append-only `work_item_runs` table
    (`(workflow_run_id, job_name, item_key, root_key, at)`, UNIQUE per run+item)
    attributes WHICH workflow run advanced each item: `markWorkItem` records a
    linkage row (using the SAME resolved `root_key`) whenever it runs inside a
    workflow run — it reads the run id from its optional `workflowRunId` param,
    defaulting to `process.env.LOCALJOBS_WORKFLOW_RUN_ID` (set by the executor for
    every child), so existing call sites are UNCHANGED and a standalone run records
    nothing. This powers the **genuinely run-scoped** workflow-run Input→Output
    panel: `workItemIoRows(first, last, runId)` lists ONLY the roots that run
    advanced (resolving each one's input + output from the cumulative ledger), and
    returns `{ rows, scoped }`. A run with NO linkage (an OLD run created before
    this feature, or a re-run that advanced nothing new) returns empty + `scoped:
    false` — it does NOT fall back to dumping the global ledger; the API
    distinguishes the two cases via `workflowHasRunLinkage(name)` (workflow has
    linkage elsewhere → "processed no new items"; none at all → "pre-feature").
    Being a brand-new table, its index lives in `schema.sql` (the columns exist on
    creation for fresh AND existing DBs, so it does NOT hit the T098 trap).
  - **The FIRST stage owns the per-item list (convention).** A multi-stage
    workflow's first stage must record the canonical per-item work-item list that
    the rest of the pipeline keys on — one `markWorkItem` per input item, keyed by
    the stable id every downstream stage uses (e.g. places-ingest records one item
    per CID-bearing place, keyed by CID). Do this **even for a bulk-prep first stage**
    that produces a single file: it parses the CSVs into `places.json` *and* emits the
    ledger list (`recordIngestLedger`). Why: the work-item ledger — and the
    workflow-run **Input → Output mapping**, which pairs the FIRST stage's work_items
    with the LAST stage's by `root_key` — is anchored from stage one. If the first
    stage records nothing, the IO panel has no input side and renders **empty**
    (the places bug: ingest used to produce only a file, so the panel was blank). A
    bulk first stage re-records the full current list each run (idempotent upsert; it
    doesn't skip). Keep the first stage's item key == the downstream `root_key` so the
    mapping joins cleanly. **It must still filter by `ctx.rootAllowed`** like every stage
    (T094) — on a *limited* manual run only the selected roots are recorded, so the ledger
    + IO mapping reflect the limited subset (the full catalog file is still written; only
    the ledger is scoped). This is SEPARATE from the **root stage** (the first member
    declaring `inputKeys()`, which drives the limit): that stays the first stage whose
    ledger *meaningfully tracks per-item completion* (for places that's the resolver, not
    ingest — ingest marks every item `success` at once, which would break the limit's
    "pick the first N not-yet-done roots" logic if ingest were the root).
  - **Pruning orphaned ledger rows (manual only).** When a job's input keys
    change (e.g. a source id is corrected), the old keys leave orphaned
    `work_items` behind. A job can expose its current input key-set via an
    optional `inputKeys()` on its `JobDefinition`; a **manual** prune
    (`POST /api/jobs/:name/prune`, or `pruneOrphanedWorkItems`/`orphanedWorkItems`
    in `store.ts`) then removes ledger rows whose key is no longer in that set and
    reports exactly what it removed. This is **never automatic** — nothing in the
    run/schedule path calls it. The API accepts an explicit `{ keys: [...] }`
    (used when a job has no `inputKeys()`), a `{ dryRun: true }` preview, and
    refuses an empty current set unless `{ force: true }` (an empty set would
    orphan every row — a guard against a misbehaving `inputKeys()`).
  - **Input lineage + manual run-limits (T094).** A manual workflow run can be
    capped to **N originating inputs** (`POST /api/workflows/:name/run { limit: N }`,
    or the number box beside ▶ Run now); **all** fan-out of each selected root runs
    to completion (the cap bounds roots, not per-stage counts), and **scheduled runs
    are always unlimited**. The framework tracks lineage via two nullable
    `work_items` columns — `root_key` (the originating input an item descends from)
    and `parent_key` — resolved in `markWorkItem` (`store.ts`): rule 1 explicit
    `rootKey` wins, rule 2 inherit the `parentKey` row's root, rule 3 default
    `root_key = item_key`. So **same-key stages need NO lineage args** (perfumes:
    every stage keys by `p.id`); only **key-changing / fan-out stages pass `rootKey`**
    (places enrich/llm pass `rootKey: cid` since they key by `place_id`). The **root
    stage** is the first member (topological order) declaring `inputKeys()` — its
    keys are the candidate roots; selection (`selectPendingRoots` in `store.ts`)
    freezes the first N *pending* roots on the run row (`run_limit` +
    `selected_roots` JSON) in `runWorkflow`. The id is threaded to each child via the
    `LOCALJOBS_WORKFLOW_RUN_ID` env (`executor.ts`); the child (`runJob.ts`) loads
    `getWorkflowRunRoots` into `ctx.selectedRoots()`/`ctx.rootAllowed(rootKey)`. **Every
    stage MUST filter its work-list by `ctx.rootAllowed(root)`** — when unlimited it's
    a no-op (the set is null → always true), so unlimited runs behave exactly as
    before. A workflow is *limitable* (the API surfaces `limitable`; the dashboard
    shows the box) only when some member declares `inputKeys()`. ⚠️ A key-changing
    stage that marks a derived item WITHOUT `rootKey`/`parentKey` makes it its own
    root → silently skipped under a limit; always pass lineage on such stages.
    - **"Pending" is propagation through the TERMINAL stage, not just past the entry
      stage (T163).** `selectPendingRoots` takes the DAG's **terminal wave** job names
      (`dag.waves[last]`, threaded from `runWorkflow`) and `isRootPending` decides a
      root is pending unless it's *fully processed*: (1) any retryable not-done row
      anywhere → pending; else (2) a *done* terminal-stage row for that `root_key` →
      fully done; else (3) a "gave-up" marker (an `ignored` or retry-exhausted
      `failed` row at any stage) with no retryable work → stuck below the terminal,
      treated as done so the selector can't **livelock** on an unprogressable root;
      else (4) it has un-attempted downstream work (entry done, a later stage has NO
      row at all — e.g. a resolved-but-not-enriched place) → **pending**. Step (4) is
      the bug fixed: the old logic asked only "is the *entry* stage done OR is there an
      existing outstanding row", so a root whose later stages simply hadn't been
      attempted (no row) looked complete and a limited backlog catch-up selected **0
      roots and silently no-op'd** while reporting success. Guard: when a limited run
      computes an EMPTY `selected_roots` from a NON-empty candidate set, `runWorkflow`
      logs a clear **WARN** on the run ("limit N … 0 originating inputs were
      selectable — N candidate(s), all already complete") instead of quietly
      succeeding. (Unlimited/scheduled runs never call `selectPendingRoots`; each stage
      just processes its own not-done items — unaffected.)
  - **Stuck vs ignored: unstick vs ignore (both manual only).** An item that
    failed past `maxAttempts` is **stuck** — it won't retry and surfaces on the
    dashboard front page / alerts (`stuckItems`, `stuckCount`). Two manual
    controls resolve it, and they are opposites: **unstick**
    (`POST /api/stuck/unstick`, `unstickWorkItem`) DELETES the failed ledger row
    so the item is RETRIED fresh next run; **ignore**
    (`POST /api/stuck/ignore`, `ignoreWorkItem`) marks the failed row
    `ignored` — a permanent "give up on this one" for genuinely bad data. There
    is exactly ONE manual-park concept (`ignored`, not a separate "dismissed"):
    an ignored item drops off the stuck list, is **never counted as stuck**, is
    never reprocessed or resurrected by a re-run (`isWorkItemDone` treats
    `ignored` as done), and surfaces ONLY on the overview's **Ignored** tile
    (`GET /api/ignored`, `ignoredItems`) — not on the workflows tab or
    workflow/job detail. Both controls act ONLY on a currently-`failed` row and
    are **never automatic** — nothing in the run/schedule path ignores anything.
    (DB note: the legacy `dismissed` status is migrated to `ignored` on startup
    in `src/db/index.ts`.)
  - **Ignore-to-suppress a SURFACED (non-failed) item (T145).** The audit-style
    workflows (`missing-tv-seasons`/`movie-recommendations`) whose ledger tracks "have I notified this?" rather
    than work-done need to ignore a still-VALID surfaced item (a franchise film the
    owner owns some-but-not-all of and deliberately doesn't want) — NOT a `failed`
    one. `ignoreSurfacedItem(jobName, itemKey)` in `store.ts` EXTENDS ignore to this
    case: it UPSERTS the ledger row to `ignored` (creating it if absent — a surfaced
    gap is typically `success` after its one notification, or has no row yet),
    whereas `ignoreWorkItem` requires a `failed` row. The notify stage then excludes
    ignored keys from BOTH the report (`ignoredItemKeys(jobName)`) AND notifications
    (`isWorkItemDone` already treats `ignored` as done, so it's never re-notified).
    Wired for movies via `POST /api/movie-gaps/:tmdbId/ignore` + a "Recommendations &
    gaps" management section on the **movie-recommendations workflow detail page** (`/workflows/movie-recommendations`,
    gated to render only for that workflow — T152 folded it in from the old dedicated
    top-level `/movie-gaps` page); still MANUAL-ONLY (nothing auto-ignores). Reuse this shape for
    any future periodic-audit workflow that needs the owner to permanently silence a
    factual-but-unwanted finding. The movie-recommendations **recommendation layer** (T146) reuses
    it verbatim for recs: `ignoreSurfacedItem('movie-recs', <tmdbId>)` excludes a rec
    from both the merge (it filters `isWorkItemDone`) and the digest/report — so an
    ignored ("not interested") rec never resurfaces. The owner-facing trigger is
    `POST /api/movie-recs/:tmdbId/ignore` with a dashboard Recommendations section on the
    movie-recommendations workflow detail page (T209, mirroring the franchise-gaps section).
    A `movie-recs` ledger row keyed by
    the recommended film's tmdb id also serves as the **never-re-recommend** dedup log
    (`success` = already recommended), distinct from the `movie-gaps-notify` ledger.
  - **Bulk collection/show dismiss (T210).** Each grouped output section on the
    workflow detail page (`dashboard/app/workflows/[name]/page.tsx`) — movie franchise
    gaps grouped by collection (`MovieGapsManager` / `groupByCollection`) and missing TV
    seasons grouped by show (`MissingSeasonsManager` / `groupByShow`) — shows an
    **"✕ Ignore all"** button at each group header. After a confirm it ignores all
    currently-active items in that group via `ignoreSurfacedItems(jobName, itemKeys[])`
    in `src/db/store.ts` (a transactional batch of the per-item upsert). **CRITICAL
    semantics: this is NOT a standing rule on the collection.** Only the exact item
    keys surfaced right now are ignored; a new item key appearing in a later run (a
    4th film in the collection, a new missing season) surfaces fresh and is NOT
    auto-ignored. Do NOT persist any collection-level "ignored" flag. Backed by two
    endpoints: `POST /api/movie-gaps/ignore-bulk { tmdbIds: number[] }` (each →
    `ignoreSurfacedItem(MOVIE_GAPS_JOB, gapKey(id))`) and `POST /api/missing-seasons/ignore-bulk
    { items: { tmdbId, season }[] }` (each → `ignoreSurfacedItem(PLEX_SEASONS_JOB,
    pairKey(tmdbId, season))`), both behind the global loopback/token mutation guard.
    Client helpers: `api.ignoreMovieGapBulk(tmdbIds)` and
    `api.missingSeasonsIgnoreBulk(items)` in `dashboard/app/lib/api.ts`.
  - **Bulk unstick/ignore with scope (T118).** The per-item controls above are
    complemented by bulk operations: `bulkUnstickItems(scope)` /
    `bulkIgnoreItems(scope)` in `src/db/store.ts`, backed by
    `POST /api/stuck/unstick-bulk` and `POST /api/stuck/ignore-bulk` in
    `src/api/server.ts`. Both act ONLY on currently-`failed` rows (same semantic as
    the single-item operations). The scope parameter limits the action to a subset:
    `{ type: 'all' }` (default — every stuck item), `{ type: 'job', jobName }` (one
    job), or `{ type: 'workflow', jobNames }` (member jobs of a named workflow; the
    API resolves the workflow name to its member list via `getWorkflowJobs`).
    The API request body is `{}` / `{ scope: 'all' }` for all, `{ scope: 'job', job
    }` for one job, or `{ scope: 'workflow', workflow: 'name' }` — the server
    returns `{ ok, unstuck }` / `{ ok, ignored }` with the count of rows affected.
    An unknown workflow name returns **400**. The bulk endpoints obey the same
    global loopback/token mutation guard as all other POST endpoints.
    The **`StuckPopover`** component in `dashboard/app/ui.tsx` is the reusable UI:
    it takes `items: StuckItem[]`, an optional `scope?: BulkScope`, `onClose`, and
    `onAction`. It renders the item table with per-item ↻ Unstick / ✕ Ignore
    buttons plus "Unstick all" / "Ignore all" bulk actions — bulk actions prompt a
    confirmation before calling the API. The Overview page opens it from the Stuck
    tile and the "Manage all…" header button; T119 wires it from the Workflows view.
    The `StuckPopover` reuses the existing `.db-modal-overlay` / `.db-modal`
    chrome and adds only `.stuck-popover` (wider width) and `.stuck-popover-bulk`
    (footer action row) in `dashboard/app/globals.css`.
- **Spend / usage caps.** For jobs that make metered external calls (paid APIs),
  enforce per-day AND per-month caps via the `job_usage` meter in `src/db/store.ts`
  (`recordUsage`, `capStatus`). Call `recordUsage(jobName)` once per real action;
  check `capStatus(jobName, dailyCap, monthlyCap)` in the loop and stop gracefully
  when `!allowed`. Convention: daily cap = monthly cap / 10 (so manual re-runs
  don't blow the month) — but a **daily-scheduled** job/workflow must use daily =
  monthly / 30, so a full month of daily runs exactly fits the monthly ceiling and
  a single day's run can never blow it (see `src/services/lib.ts`'s
  `DAILY_SPEND_DIVISOR`). Caps live in the job's config (or, for service-governed
  paid calls, on the service), env-overridable.
  **One governor only:** if a paid call already goes through a shared **service**
  (below), the service quota is the SINGLE source of truth — do NOT also stack a
  per-job `job_usage` cap on the same calls (it shadows the service's
  `QuotaExceededError` soft-fail and double-meters). The places paid jobs
  (`places-enrich`→`google-places`, `enrich-with-llm`→`gemini`) govern spend
  purely via their service quota; `src/services/lib.ts`'s `DAILY_SPEND_DIVISOR`
  feeds the *service* caps.
  Use the per-job `job_usage` meter only when the metered call is NOT routed
  through a service.
- **Services are a TOP-LEVEL, daemon-wide concern (`src/services/`).** A service's
  rate-limit/quota is coordinated GLOBALLY by service NAME (via the SQLite
  `service_usage` meter), so a service is NOT owned by any one workflow — it lives
  in the top-level `src/services/` folder (sibling of `src/core`/`src/jobs`),
  default-exporting a `ServiceDefinition` from `src/services/<name>.service.ts`.
  Each service is **self-contained**: it owns its limits, reading them from env
  with sensible defaults, and imports **NOTHING from any workflow's `config.ts`**.
  The `daily = monthly / 30` spend-cap math for paid daily-scheduled services lives
  with the services (`src/services/lib.ts`'s `DAILY_SPEND_DIVISOR` /
  `dailyFromMonthly`), NOT in a workflow config. The registry discovers services
  from `src/services/` (and still scans `src/jobs/` so a private job MAY colocate a
  service it owns).
- **A service's `category` is manifest-owned only — no dashboard edit UI (T305,
  mirrors workflow `category` from T292).** Like workflow `category`, a service's
  `category` is a pure grouping label (for the Services dashboard page) with NO
  `_overridden` column and NO edit endpoint: `syncService` always refreshes it from
  the manifest's `category` field on every sync (same as `description`/`paid`), so
  there is nothing for the owner to override. Controlled values: `'cli-tool'`
  (`claude-cli`), `'website-scrape'` (`fragrantica`), `'api'` (the remaining
  services — `gemini`, `github`, `google-places`, `hevy`, `lastfm`, `tmdb`,
  `trading212`, `dynamodb`, `openfigi`). A manifest with no `category` set defaults to
  `'uncategorized'`. The `category` column is added by `schema.sql` (fresh DBs) +
  an additive `ALTER TABLE` migration in `index.ts` (existing DBs, per the T098
  rule — no index on the new column).
- **`openfigi` service (`src/services/openfigi.service.ts`)** — free, read-only ISIN -> ticker
  symbol resolution via Bloomberg's OpenFIGI mapping API
  (https://www.openfigi.com/api/documentation), for jobs that need to turn a broker's ISIN into a
  current real-world ticker. `OPENFIGI_API_KEY` is optional (raises the free-tier rate limit).
- **Services (cross-job shared APIs).** For an external dependency called from
  multiple jobs (e.g. Gemini, Google Places, Fragrantica, Claude CLI), define a
  self-contained `ServiceDefinition` in `src/services/<name>.service.ts` and call
  the API through `callService(name, fn)` from `src/core/services.ts`. This
  coordinates rate
  limits and quotas across all job processes via the SQLite `service_usage` meter,
  and is the SOLE spend governor for those calls — a hit day/month quota throws
  `QuotaExceededError`, which the caller catches to stop the run gracefully (the
  item is left un-done and the next run resumes). See `src/services/gemini.service.ts`
  and `src/services/fragrantica.service.ts` for worked examples. The simpler per-job
  `recordUsage`/`capStatus` on `job_usage` still exists for single-job-only
  metering when cross-job coordination isn't needed. (When migrating an existing
  job onto a service, top up `service_usage` from its historical `job_usage` once
  with `scripts/backfill-service-usage.ts` so the month's count carries over.)
  - **Limits are code-seeded but user-overridable.** `ratePerMinute` / `dailyCap`
    / `monthlyCap` from the `ServiceDefinition` seed the `services` row on sync,
    but the Services dashboard page can edit them
    (`POST /api/services/:name/limits` → `updateServiceLimits` in `store.ts`).
    An edit flips `limits_overridden = 1`; from then on a code-sync PRESERVES the
    user's values (description/paid stay code-owned and refresh) — the same
    reconcile the user-owned `enabled` flag gets. `callService` enforces the
    EFFECTIVE limit (`effectiveLimits` in `core/services.ts`): the override when
    set, else the code default — so an edit takes effect for the next call without
    a code change. `minIntervalMs`/`maxJitterMs` are NOT editable (code-only).
  - **Runtime-recorded service consumers (T186).** `callService` upserts a row in
    the `service_consumers` table (`service_name`, `job_name`, `last_used` — UNIQUE on
    the pair) whenever a job calls a service, recording WHICH job used WHICH service.
    The job name is read from `process.argv[2]` (the child process entrypoint always
    receives the job name there). `GET /api/services/:name/consumers` (read-only) returns
    the consumers grouped by workflow (joined via `workflow_jobs`), powering the
    Services page's click-to-expand consumer list. The table is a brand-new schema
    addition (no T098 trap).
- **Headless-browser scrapes (shared launch helper).** Any job that drives a
  real browser to scrape a reputation-gated site (Cloudflare et al.) should launch
  via `launchPersistentBrowser` from `src/core/browser.ts` rather than calling
  `chromium.launchPersistentContext` inline. It encapsulates the proven learnings:
  a persistent on-disk profile (keeps the clearance cookie across pages AND runs),
  the real-Chrome channel with a bundled-chromium fallback, an anti-automation
  flag + realistic UA/viewport/locale, and stale-`Singleton*`-lock cleanup. The
  block is rate/reputation-based, not per-request detection — so this owns only
  the *launch*; the job still **paces** its requests (jittered min-interval),
  ideally via a shared **service** (the `fragrantica` service does the spacing
  while `core/browser` does the launch). `jitteredDelayMs` in the same module is
  for jobs that pace their own loop instead of routing through a service. See
  `perfumes/fetch.ts` for the worked example.
  **Shared Chrome profile:** the persistent profile lives at the framework level
  (`data/chrome-profile/`, env-overridable via `LOCALJOBS_CHROME_PROFILE`),
  exported from `src/core/browser.ts` as `defaultChromeProfileDir`. All scrape
  jobs should use it via `perfumesConfig.profileDir` / `defaultChromeProfileDir`
  rather than defining a job-local path — one shared, warmed, trusted profile
  means any job benefits from cookies accumulated by others.
- **Validation gates between workflow stages (typed artifacts).** See
  `src/jobs/CLAUDE.md` for the short, hard-requirement statement of this rule
  (every DAG edge needs a gate; a trivial `check(): { ok: true }` is an
  acceptable minimum) — it's the one that surfaces automatically when working
  inside `src/jobs/`. This is now **mechanically enforced**:
  `src/core/gate-coverage.test.ts` walks every workflow the registry loads and
  fails `npm test` if any DAG edge is missing a matching gate. A job may
  declare `produces` and/or `consumes` — arrays of `ArtifactContract`
  (`{ key, description?, shape?, check() }`) in `src/core/types.ts`. For every workflow
  **edge** where the upstream `produces` a key the downstream `consumes`, the
  workflow executor runs both contracts' `check()` at that boundary — producer
  side (output well-formed) right before, consumer side (input acceptable) — and
  a `check` returning `ok:false` (or throwing) is a **gate violation**: the
  consumer never spawns, a first-class **failed** run is recorded
  (`recordGateFailure`, error = the exact drift), a stage notification fires, and
  the failure cascades to the consumer's own dependents. This is how an
  external-format drift (Takeout CSV layout, Fragrantica page structure) fails
  LOUD at the exact gate instead of feeding bad data downstream. The `check`
  should inspect the REAL artifact (read the `data/` file, sniff the scraped
  page) and return precise per-drift `violations`. Gate derivation
  (`deriveGates`) lives in `src/core/dag.ts` (pure, edge-scoped — a consumed key
  with no producing upstream is an external input, not a gate); enforcement lives
  in `src/core/workflow-executor.ts`. Both example workflows declare these: the
  contracts live in `src/jobs/places/contracts.ts` and
  `src/jobs/perfumes/contracts.ts` as small **factory functions** (each takes an
  optional path defaulting to the job's real `data/` artifact, so the jobs wire
  `produces:[…()]`/`consumes:[…()]` while unit tests point them at synthetic
  fixtures). The checks are deliberately SHAPE + NON-EMPTY (exists · non-empty ·
  expected fields/columns) — enough to catch real drift without brittle
  full-schema validation. Each workflow derives 3 gates (one per stage boundary).
  Gate **state** is surfaced on the dashboard's workflow-run DAG: `classifyGates`
  (also in `src/core/dag.ts`, pure) maps each gate to `passed`/`failed`/`pending`
  from the run's member runs — a gate is `failed` when its consumer's latest run
  is a gate-failure (matched via the shared `gateFailurePrefix`, the SAME format
  `recordGateFailure` writes), `passed` once the consumer actually ran, else
  `pending`. The `GET /api/workflow-runs/:id` endpoint returns this as `gates[]`
  — each gate carries its `description` (what the producer's `produces[key]` and
  consumer's `consumes[key]` contracts ASSERT, enriched in the API's
  `gatesForWorkflow`), so a gate is inspectable, not just coloured.
  `dashboard/app/components/DagFlow.tsx` renders a gate mark per gate as a React Flow edge label
  on the connecting edge between the specific producer and consumer nodes it guards (T204). The
  graph layout uses topological columns (each node's column = max(parent columns) + 1) with dagre
  computing the vertical ordering — every edge reflects the actual `dependsOn` relationship, so
  there are no false wave-barrier implications (e.g. `franchise-gaps` and `rec-merge` in
  movie-recommendations have no implied ordering). EVERY mark (passed/failed/pending alike) links
  directly to that gate's dedicated detail page
  (`/workflow-runs/<id>/gates/<producer>/<key>`), which shows what the gate
  validates (key + description, producer→consumer), its outcome, and links to the
  producer/consumer/violation run logs. Gates render ONLY when a run's `gates` prop is passed — the
  structure-only `/workflows/[name]` graph omits it. The executor also LOGS each
  gate check to the workflow run's framework logs: a `⛒ checking gate …` line
  naming the boundary, artifact, and both contracts' assertions
  (`gateAssertions`), then a `✓ gate ok …` / `⨯ Gate violation …` result line —
  so the run page tells you what each gate verified and why it passed or failed.
  - **Expected-vs-actual gate page (black box).** Each gate has a dedicated page
    (`dashboard/app/workflow-runs/[id]/gates/[producer]/[key]/page.tsx`) that
    explains the gate to a NON-EXPERT with no knowledge of internals. It lays the
    boundary out left-to-right — **Produced →** → **Gate** (what it checks) →
    **→ Consumed** — and on each side shows the contract's declared
    **expected shape** alongside the **actual** artifact's per-expectation ✓/✗ and
    a small sample. To support it, an `ArtifactContract` may declare a
    machine-readable `shape: ArtifactShape` (`{ summary, format?, expectations[] }`,
    each expectation a plain-English `{ label, detail? }`), and its `check()`
    returns `GateResult.checks[]` (per-expectation `{ label, ok, actual? }`, aligned
    to the shape BY LABEL) plus a `sample` string. `ok`/`violations` are still
    derived from the failed checks (the contract helper `fromChecks` does this), so
    executor enforcement is unchanged — keep the labels in `shape.expectations`
    identical to the ones the `check` emits. The page is served by
    `GET /api/workflow-runs/:id/gates/:producer/:key`, which classifies the gate
    state for the run and runs each side's contract `check()` LIVE (produced =
    producer's `produces[key]`, consumed = consumer's `consumes[key]`). That endpoint
    reads `data/` files only — NEVER a paid/remote call — so it is safe to poll;
    keep any future contract `check()` cheap + side-effect-free for the same reason.
  - **Collapse identical producer/consumer sides to ONE panel (T138).** In this
    codebase every gate references the SAME contract factory on both sides
    (`fragranticaDataContract()` is both parse's `produces` and build's `consumes`),
    so the **Produced →** and **→ Consumed** `SideCard`s show an IDENTICAL shape +
    identical actuals — pure redundancy. Both gate detail pages therefore COLLAPSE
    to a single consolidated panel (boundary + ONE **Expected shape** + the run's
    actual ✓/✗ + sample, keeping the centre **Gate** block and the producer/consumer/
    violation log links) whenever the two sides are identical, and fall back to the
    full two-sided `Produced → | Gate | → Consumed` diff when they DIFFER. "Identical"
    is decided server-side: BOTH gate inspection endpoints return an `identical:
    boolean` computed by `shapesIdentical(a, b)` (pure, in `src/core/dag.ts`,
    unit-tested) — a deep compare of the two sides' DECLARED `shape` (`summary` +
    `format` + the `expectations` array by `label`+`detail`); a missing shape on
    either side is treated as NOT identical (never hide a side we can't confirm).
    The framework genuinely supports **asymmetric / fan-in** gates — `deriveGates`
    is edge-scoped (one gate per producer→consumer edge, so ≥2 producers feeding one
    consumer derive one gate each) and the executor's `enforceGate` checks the
    producer's `produces[key]` and the consumer's `consumes[key]` INDEPENDENTLY, so
    differing shapes both run + are enforced. The places/perfumes jobs keep the
    one-factory-per-key convention (so they always collapse); asymmetry is exercised
    only by test fixtures (`dag.test.ts`, `server.test.ts`, `workflow-executor.test.ts`).
  - **Definition-level (run-agnostic) gate page (T102).** The run-scoped page above
    belongs to a SPECIFIC run. The workflow DEFINITION view (`/workflows/[name]`)
    instead links each structural gate chip to a run-AGNOSTIC gate page at
    `dashboard/app/workflows/[name]/gates/[producer]/[key]/page.tsx` — mirroring how a
    job node there links to the read-only `/jobs/<name>` rather than into one run. It
    explains the gate ITSELF (the contract: artifact key, enriched description,
    producer→consumer, and each side's declared **expected shape**) with NO run state
    and NO actuals. It's served by `GET /api/workflows/:name/gates/:producer/:key`,
    which returns the structural gate from `gatesForWorkflow` (`deriveGates` +
    contract descriptions) plus each side's `shape` ONLY — it does **NOT** run any
    contract `check()`, so it touches no `data/` files and makes no paid/remote calls
    at all (purely static contract metadata). `DagFlow`'s structural gate chips take a
    `workflowName` prop to build these definition-view links; run-view chips use
    `workflowRunId` → the run-scoped page.
- **Workflow progress is rolled up from member jobs (don't set it by hand).** A
  workflow run's `progress` is a first-class roll-up that counts **only completed
  stages** over the workflow's total stage count — a member in a terminal state
  contributes a full stage (1); a still-running or not-yet-started member
  contributes 0 (**no partial credit** for in-flight work). So with N stages the
  bar stays at 0% until the first stage finishes, then **steps in 100/N
  increments** per completed stage (4 jobs → 0/25/50/75/100; 5 jobs →
  0/20/…/100). `setProgress` (the executor's per-member progress writer) calls
  `rollUpWorkflowProgress` in `src/db/store.ts` whenever a workflow member emits
  progress or settles, but a mid-run member's `progress` no longer moves the bar —
  only crossing into a terminal state does. The denominator comes from the
  `workflow_jobs` table (member count), so no new column is needed. Use
  `rollUpWorkflowProgress`, not ad-hoc `setWorkflowProgress(settled/total)`, when
  surfacing workflow progress.
- **Job resources are job-local.** A job's input/output data lives in its own
  `data/` folder next to the code (e.g. `src/jobs/places/data/{raw,out}`),
  referenced relative to the job's file — not in a far-off top-level folder.
  These are gitignored via `src/jobs/**/data/`.
- **The repo is self-contained — no absolute paths to other folders on the
  machine.** A job's config/template/resource files live in-project and are
  resolved relative to the job dir (`resolve(here, '…')`), never hardcoded to an
  external repo. Make them env-overridable where a path might legitimately vary
  (e.g. `PERFUMES_TEMPLATE_PATH` defaults to the in-project
  `src/jobs/perfumes/profile.template.md`). A bare `/Users/...` in tracked job
  code is a bug — it leaks the machine's topology and breaks on any other host.
- **Run the checks on every change** — `npm test` (the unit suite) AND
  `npx tsc --noEmit` (daemon typecheck), plus `npm run build` in `dashboard/` for UI
  changes — before declaring done. For a UI **surface** change, also run
  `node dashboard/scripts/visual-check.mjs` (after building) and LOOK at the screenshots
  (see the visual-confirmation rule below). Keep the suite green; **add unit tests for new
  behaviour as you build it** (tests live in `*.test.ts`; `npm test` discovers + runs
  them against a scratch DB). Never declare done on red.
- **Tests can NEVER touch the production DB (guarded).** `npm test` points
  `LOCALJOBS_DB` at a scratch file, but a DIRECT run (`tsx --test src/x.test.ts` or
  `tsx src/x.test.ts`) sets no such env and would otherwise fall back to
  `data/jobs.db` and pollute production — this once leaked test-fixture workflows
  (`bulk-api-wf`, `t110-wf`, …) into the live dashboard. `src/config.ts` now guards
  this: `isTestEnv()` detects any test invocation (the `LOCALJOBS_TEST=1` flag
  `run-tests.ts` sets, `NODE_TEST_CONTEXT`, a `--test` arg, or a `*.test.ts` /
  `run-tests` entry in argv) and `resolveDbPath()` refuses the production default in
  that case, redirecting to a unique per-process scratch DB (with a warning).
  `config.dbPath` goes through this. Don't bypass it — never hardcode
  `data/jobs.db` in a test, and keep new test invocations covered by `isTestEnv`.
- **Dashboard must stay mobile-responsive.** Every page has to survive a phone-width
  (~402px) viewport with no horizontal page overflow and nothing crossing an
  element's boundary. Responsive rules live in one place — the `@media (max-width:
  640px)` block in `dashboard/app/globals.css` (wide tables scroll inside their
  `.panel` via `.panel:has(> table){overflow-x:auto}`, dense grids collapse, `.kv`
  blocks stack). After any dashboard UI change, build it and run
  `node dashboard/scripts/mobile-check.mjs` (hermetic — no daemon, synthetic API
  fixtures) and keep it green. The check is local-only, not part of CI.
  ⚠️ The mobile check only exercises the DEFAULT theme/font (it sets no
  localStorage), so it guards the default look; non-default themes are
  mobile-safe by design + spot-checked manually at phone width.
- **Dashboard UI changes must get VISUAL confirmation, not just structural checks.**
  A UI element can pass `tsc`, the unit suite, the dashboard build, AND mobile-check
  yet never actually be PAINTED — the T223 gate-padlock bug shipped exactly that (an
  icon present in the DOM but invisible, because every check is structural and
  mobile-check only measures overflow on whatever rendered). So for any change to the
  dashboard's rendered surface: build it, run `node dashboard/scripts/visual-check.mjs`
  (hermetic like mobile-check — `next start` + synthetic `/api/**` fixtures, no daemon /
  SQLite / paid calls), and **LOOK at the screenshots** it writes to the gitignored
  `dashboard/scripts/visual-out/` — confirm with your own eyes the thing you changed
  renders (painted/visible, nothing blank/overlapping/clipped). It loads every page at a
  desktop viewport and waits for async/polled content (selector wait + a 1–5s settle).
  It is **vision-only** — it captures screenshots for judgment and asserts NO appearance
  invariants (NOT golden-image diffing, so no baselines / no cross-machine pixel drift);
  it fails only on a hard error (page didn't load, a wait selector never appeared, a
  console error). Local/loop-only, **not** in CI (no browser there).
  - **LIVING ARTIFACT RULE (non-negotiable).** The page list, fixtures, theme seeding,
    and **interaction flows** live in ONE place — `dashboard/scripts/_dashboard-harness.mjs`,
    shared with mobile-check. `PAGES` is one baseline shot per route; `FLOWS` adds shots of
    states that need an interaction first (a collapsed section expanded, a popover opened) —
    each a `{ name, path, actions(page) }` that drives Playwright before the screenshot. Any
    UI-surface change — adding a page, adding/removing a workflow or gate, removing UI, or
    adding an interactive state worth seeing — **MUST update that file in the SAME change** so
    future runs stay accurate and don't start failing on intentionally-removed things. Treat a
    stale `PAGES`/`FLOWS`/fixture exactly like stale docs: it's a bug, and it's part of Done. (The
    autonomous loop enforces this for `facets.layer == ui` tasks — it injects the
    look-at-the-screenshots step into both the builder and the sampled auditor, and
    auto-exempts these script files from the scope gate so keeping them current is never
    punished.)
- **Shared dashboard UI components (T268) — reuse, don't re-implement.** Common
  dashboard elements live in `dashboard/app/components/` and `dashboard/app/ui.tsx`
  (the existing shared layer: `StatusBadge`, `ThemeControls`, `StuckPopover`, etc.).
  New dashboard UI MUST reuse these instead of duplicating markup + class names:
  - **`<RunButton>`** (`dashboard/app/components/RunButton.tsx`) — the workflow run-
    trigger button wrapping `.btn.btn-run`. Props: `isRunning` (disable + show
    "Running…" when a run is active), `busy` (disable + show "Started…" while the
    click is in flight), `onClick`, `label`/`runningLabel` overrides, `className`.
  - **`<Pill>`** (`dashboard/app/components/Pill.tsx`) — any label/chip wrapping
    `.pill`. Pass `kind` for the modifier class (e.g. `kind="on"` → `className="pill
    on"`). Existing kinds in `globals.css`: `on`/`off`, `reviewed`/`unreviewed`,
    `done`, `failed`, `buildable`, `human`, `dep-waiting`, `paid`/`free`. New
    enumeration labels must use `<Pill>`, not bare `<span className="pill ...">`.
  - `DagFlow`, `WorkflowOutputSection` — existing components for the workflow DAG
    graph and unified output panel.
  When adding a new reusable element, add it to `dashboard/app/components/` (NOT
  inline in a page) and document it here. Do NOT introduce a new styling system —
  wrap the existing `globals.css` class idiom.
- **Boxed empty-state convention (T345) — `.empty-state-panel`.** A "nothing here
  yet" message should render inside `<div className="panel"><p
  className="empty-state-panel">…</p></div>`, NOT as a bare `<p className="muted">`
  floating on the page background. `.empty-state-panel` (`globals.css`) horizontally
  AND vertically centres a short sentence within its `.panel` wrapper — reuse it for
  future empty states instead of duplicating ad-hoc centring CSS. (A related,
  IO-panel-specific class, `.io-empty-state`, predates this and is left as-is.)
- **Dashboard appearance is CSS-variable-driven + has a live theme/font switcher
  (T142 → T154 evaluation, curated down in T184).** All colours/fonts come from
  `:root` custom properties; a header **🎨** control (`ThemeControls` in
  `dashboard/app/ui.tsx`) flips persisted (localStorage) html attributes on
  `document.documentElement`. The curated set (T184) is:
  - **`data-theme` — the theme FAMILY, exactly 3:** `default` (plain), `pixel-picnic`,
    `sunny-8bit`. The switcher only picks the family.
  - **`data-mode` — the RESOLVED value is always `light` | `dark`; the user's CHOICE
    is `dark` | `light` | `system` (T344, reintroducing System on top of T308's
    binary toggle — a deliberate owner UX reversal).** The header **🎨**-successor
    control — a single compact icon button (`ThemeControls`/`useMode` in
    `dashboard/app/ui.tsx`), not a popover — CYCLES the choice Dark → Light →
    System → Dark on each click, persisted as `localjobs.mode` (the literal string
    `'dark'`/`'light'`/`'system'`; `'system'` is written explicitly, not just left
    unset). Each state has its own icon: 🌙 dark, ☀️ light, 🖥️ system. In System
    state — also the default when nothing is stored — `data-mode` follows the OS
    `prefers-color-scheme` live via a `matchMedia` change listener attached only
    while in System state; Dark/Light force a fixed `data-mode` and detach that
    listener. Each of the 3 theme families has a **light + dark palette** in
    `globals.css` (6 total). The family's BASE rule carries its DARK palette (so a
    JS-less viewer still gets a coherent theme) and a `[data-mode="light"]` rule
    overrides to light; the `default` family is the exception — its DARK palette IS
    `:root` (unchanged, the original pre-T142 dark look) and only its light override
    is defined. `data-mode` is set BEFORE first paint by the pre-paint inline script
    in `layout.tsx` (reads `localjobs.mode`; `'dark'` forces dark, `'light'` forces
    light, anything else — `'system'` or unset — follows `prefers-color-scheme`) and
    kept in sync after hydration by `useMode()`. The pure `resolveMode(stored,
    osPrefersDark)` helper in `ui.tsx` maps the stored choice → effective
    `data-mode` (`null`/`'system'` both follow the OS preference).
  - **`data-font` — exactly 3:** unset = System default, `baloo` (Baloo 2, a rounded
    face; uses a lighter `--heading-weight: 500` so headers read crisp), `spacemono`
    (Space Mono everywhere). Only **two faces are loaded** via `next/font/google` in
    `layout.tsx` (Baloo 2 + Space Mono) — no other faces are shipped.
  - **`data-motion="reduced"`** — dampens animations + hides emoji; defaults to the
    OS `prefers-reduced-motion`.
  Hard rules to preserve: the **untouched default** (default family, no attributes
  set) — and the default family's DARK mode generally — must render exactly as the
  pre-T142 dark look, so joyful accents are gated by
  `html[data-theme]:not([data-theme="default"])` and `--heading-weight` defaults to
  `700` (the original bold headings); **logs keep a fixed dark-terminal palette**
  (`--logs-*` in `:root`, never overridden by a theme or by light mode) so streaming
  logs stay legible in both modes; and display/rounded faces only ever map to
  `--font-display`/`--font-body`, never the log/mono surfaces (except the deliberate
  Space Mono everywhere). Confine theme/font/accent CSS to `globals.css`, the
  switcher+hooks to `ui.tsx`, and font loading + the pre-paint script to
  `layout.tsx`.
- **Commit + push as you go.** See the "⚠️ Commit + push as you go" section near the top
  of this file — it's a hard rule here, not a style preference, because of how
  `LOOP_AUTORESET` treats a dirty tree.
- **Always restart what you changed — a change isn't live until you do (part of Done).**
  The daemon loads job/daemon code at startup and the dashboard serves a prebuilt
  bundle, so editing files changes nothing in the running product until you restart.
  Whenever you touch:
  - **`src/` (daemon/jobs):** restart the daemon —
    `launchctl kickstart -k gui/$(id -u)/com.ryankrol.localjobs`
  - **`dashboard/` (UI):** rebuild **and** restart it —
    `npm --prefix dashboard run build && launchctl kickstart -k gui/$(id -u)/com.ryankrol.localjobs-dashboard`

  Do this in the same step as the change so what's running always matches `main`.
  (DB-only data fixes don't need a restart, but they do need to be safe to re-run.)

## Ports & services
- **API / daemon:** `http://127.0.0.1:4789`
- **Dashboard:** `http://localhost:4788`
- launchd agents: `com.ryankrol.localjobs` (daemon),
  `com.ryankrol.localjobs-dashboard` (dashboard). Install via
  `scripts/install-launchd.sh` and `scripts/install-dashboard-launchd.sh`.

## Gotchas
- The in-process scheduler can't fire while the Mac sleeps — the Mini must stay
  awake (`sudo pmset -a sleep 0 disablesleep 1`).
- Changing job code without restarting the daemon = no effect.
- SQLite datetimes are UTC strings without `Z`; the dashboard appends `Z` when
  parsing (see `app/ui.tsx`). Preserve that.
- **Never let `data/` folders be scanned for code, by anything.** The job registry
  (`src/jobs/registry.ts`), `tsconfig.json`, and the test runner
  (`scripts/run-tests.ts`) all now explicitly exclude any directory literally named
  `data` from their recursive walks. This was a real incident: `projects-sync`'s
  clone-and-summarize stage (T288) shallow-clones the owner's own GitHub repos into
  `src/jobs/projects-sync/data/repos/<name>/` — cloning `LocalJobs` (this very repo)
  produced a full copy of every `*.job.ts`/`*.workflow.ts` file under `src/jobs/`,
  nested inside a `data/` tree. Job/workflow lookup is by NAME not file path
  (`jobs.find(j => j.name === name)`), and `findFiles(...).sort()` orders by full
  path string — so for any workflow whose folder name sorts alphabetically AFTER
  `projects-sync` (`stocks-sync`, `tv-recs`, `workouts-sync`, and even
  `projects-sync` itself via its own nested self-clone), the STALE CLONED COPY
  silently won and shadowed the real one. Workflows have a duplicate-name guard
  (logs `is invalid — skipped: duplicate workflow name`) but jobs did not — a
  shadowed job's relative imports (`../../../db/store.js` etc.) resolve INSIDE the
  clone, so it ran against its own copy of the ENTIRE framework, including a
  separate SQLite file it created inside the clone (`data/repos/LocalJobs/data/jobs.db`).
  Symptom: workflow runs reporting "skipped (nothing to do)" or writing real output
  to the wrong path, while the real `data/out/` stayed stale or was never created.
  If you ever see a job/workflow behaving as if it's running OLD code that doesn't
  match the current source, or writing output somewhere unexpected, suspect this
  class of bug first — check for any `data/repos/`-style generated tree under
  `src/jobs/**` that a workflow might have produced, and confirm the registry
  still excludes `data/` (`src/jobs/registry.test.ts`'s sibling
  `registry-find-files.test.ts` is the hermetic regression guard for this).

## Autonomous build harness (Ralph loop)

An autonomous builder (`.harness/scripts/loop.sh`, design in `.harness/docs/HARNESS.md`) can grind through a
curated backlog one fully-verified task at a time. The whole harness lives under the hidden
`.harness/` folder, separate from project source. **When you are invoked by the loop**, obey
this in addition to everything above:

- **You work directly on `main` in this checkout** — NO worktree, NO new branches, NO push,
  NO merge. Build ONE task, commit it, and stop. The loop pushes and gates on CI.
- **The backlog is shell-owned — `status` especially.** `.harness/tracking/TASKS.json` is committed; the
  loop sets a task's `status` to `done` (via a `jq` field-scoped edit that preserves every other
  field) — **never edit `status` (or any field) of `.harness/tracking/TASKS.json` yourself.** Write your
  attempt notes to `.harness/worklog/<TASK>.md` and the result line to `.harness/worklog/.result`.
  - **The owner-authorized exceptions are the `reviewed` flag (T136), the `done` flag (T208), and
    the `failed` flag (manual-fail-signal) — all human/dashboard-owned overlay files, NOT fields in
    TASKS.json.** The loop NEVER WRITES any of them (it only writes TASKS.json `status` + the
    worklog), so the writers stay decoupled.
    - **`reviewed` (T136):** lives in `.harness/tracking/reviews.json` (`id → { reviewed, at }`). Set via
      `POST /api/backlog/:id/reviewed` or bulk `POST /api/backlog/reviewed-bulk`. Both atomically
      write the file AND commit+push `[skip ci]` under the repo lock (fetch+rebase+retry; failed
      push = non-fatal warning). `GET /api/backlog` overlays `reviewed` (absent → false).
    - **`done` (T208):** lives in `.harness/tracking/human-done.json` (`id → { done: true, at }`). Set via
      `POST /api/backlog/:id/done` (needs-human tasks only — 400 otherwise). Same atomic
      write+commit+push pattern. `GET /api/backlog` overlays `done=true` and derives
      `reviewed=true` for human-done tasks (done implies reviewed). The Backlog page shows a
      "Mark done" button on needs-human tasks that aren't already done.
    - **`failed` (manual-fail-signal):** lives in `.harness/tracking/manual-fail.json` (`id → { failed,
      reason, at }`). The owner's "this DONE task actually failed" correction. Set via `POST
      /api/backlog/:id/failed` (done tasks only, reason required; `{failed:false}` undoes), via the
      Backlog page's "Mark failed" button — the sole interface (a portable, no-dashboard
      `mark-failed.sh` script + `/local-jobs-mark-task-failed` command used to exist alongside it;
      both were removed as redundant once every project this harness runs in had a dashboard).
      Same atomic write+commit+push pattern. **The loop READS this overlay** (it still never
      WRITES it) to correct calibration —
      `policy.jq`/`pick_base` re-count the task as a failure for tier tuning, and `audit_gate` drops it
      from its cell's confirmed-audited count (built stronger + audited more). It ALSO reconciles it →
      `TASKS.json` `status=failed` (see below). Design: `.harness/docs/designs/manual-fail-signal.md`.
    The agent must not hand-edit any of these overlay files — they are UI / owner actions. (To mark
    a task failed when asked, use the dashboard's "Mark failed" button, never a hand-edit.)
    - **Overlay → status reconcile (T261/T279, `reconcile_overlays` in `loop.sh`).** The loop NEVER
      writes the overlay files, but at PRE-FLIGHT it reads `human-done`/`manual-fail` and promotes their
      verdicts into `TASKS.json` `status`: human-done → `status=done` (so a needs-human blocker actually
      unblocks dependents — the loop keys on status, not the overlay), and manual-fail → `status=failed`
      (a terminal status the loop skips; NOT an auto-reopen). So the overlays are the owner's
      write-surface and `TASKS.json` status is the authoritative reconciled state; the dashboard still
      never touches `TASKS.json`.
- **Task `do`/`doneWhen` live in a per-task Markdown spec (T131).** A task's *what to build* and
  *bar for done* are NOT flat strings in `.harness/tracking/TASKS.json` — they live in `.harness/tasks/TNNN.md`
  with two sections, `## Do` and `## Done when`, referenced by the JSON task's `spec` field (a
  repo-relative path). **A task authored via `/local-jobs-convert-ideas` also gets a leading `##
  Overview`** — one or two sentences of plain, human-readable language capturing the point of the
  task at a glance, before the denser `## Do`/`## Done when` detail. This is a later addition to the
  convention: existing specs written before it don't have one and are NOT backfilled — it only applies
  going forward, to newly-authored specs. TASKS.json keeps every OTHER field (`status`, `dependsOn`, `gate`,
  `model`/`effort`/`escalation`, `scope`, `tags`, `verify`, `design` — but NOT `reviewed`, which
  lives in `.harness/tracking/reviews.json` since T136). The loop's prompt
  reads the orchestration fields from JSON and appends the spec MD verbatim; `GET /api/backlog`
  inlines it as `specContent` (`readTaskSpec`, confined to `.harness/tasks/*.md`) and the Backlog
  page renders it as markdown. **Authoring a NEW task = a JSON object with a `spec` field PLUS its
  matching `.harness/tasks/TNNN.md` (no `do`/`doneWhen` in JSON), created in the same edit.**
- **Backlog authoring: pair every "options/chooser" task with a review task (T129).** Whenever
  a backlog task builds MULTIPLE OPTIONS for the owner to choose between (toggleable styles, strategy
  variants, etc.), a PAIRED `needs-human` review task **must** also be authored that: (a)
  `dependsOn` the chooser task, (b) records the owner reviewing the options and committing to a
  choice, and (c) unblocks a follow-up that hardcodes the winner and removes the toggle + unused
  paths. Example chains: T099/T113/T116 (choosers) → T126/T127/T128 (review tasks). Never author
  a chooser task alone; always add the paired review task in the same backlog edit.
- **Backlog authoring → invoke the `ralph-loop-add-to-backlog` skill (see `.harness/CLAUDE.md`).**
  Adding tasks goes through that skill (it assigns facets, pairs chooser/review tasks, runs the
  poor-fit/layer gate). Floor even on a direct `TASKS.json` edit: every BUILDABLE task carries
  `facets` from `.harness/config/facets.json` (`needs-human` tasks omit them); the loop pre-flight warns
  about misses. Full rule lives in `.harness/CLAUDE.md` (loaded when you work in `.harness/`).
- **Definition of Done mirrors CI** (`.harness/docs/HARNESS.md` §5): `npx tsc --noEmit`, `npm test`, and
  `npm --prefix dashboard run build` for any `dashboard/` change — all green before you commit.
- **Verify correctness — paid calls allowed, frugally.** The ONE hard rule is **never exceed a
  service's monthly cap** (the `service_usage` quota enforces this — `callService` throws
  `QuotaExceededError` at the ceiling). Otherwise: prefer cached `data/` / synthetic fixtures / the
  scratch DB first, and make a live paid call (Google Places, Gemini) or live scrape only as a last
  resort to prove the work, with the smallest sample (1–2 items). **Never skip verification to save
  money** — an unverified task isn't done. Record `failed:blocked` only when verifying would have to
  exceed the monthly cap.
- **Privacy guard (non-negotiable):** never `git add` anything under a `data/` folder, a
  `chrome-profile/`, `.env*`, or a credential file; never `git add -A`/`git add .` — stage
  files explicitly. To publish job code, remove only the relevant code-folder line from
  `.gitignore` and `git add` the `.ts` files by name. The loop's pre-push guard HALTS the run if
  any sensitive path is staged.
