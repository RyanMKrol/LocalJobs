# CLAUDE.md — src/workflows/stocks-sync/

Pulls the owner's current open equity positions from Trading212
(https://docs.trading212.com/api) via a **strictly read-only** integration (GET-only, HTTP Basic auth
— see `src/services/CLAUDE.md`) and writes a local snapshot: `data/out/portfolio.json` (structured,
broker-agnostic `{ ticker, quantity, averageBuyPrice, currentPrice, currentValue, account }` array)
and `data/out/portfolio.md` (one row per position, with an Account column and the price difference
since purchase as both an absolute amount and a percentage). No DynamoDB. Five-stage DAG:
`stocks-fetch → stocks-resolve-names → stocks-snapshot → stocks-watch → stocks-notify`, each doing
one clearly-scoped thing.

## Stage 1 — `stocks-fetch`

Fetches raw positions from Trading212 and tags them by account — nothing else. Also fetches an
OPTIONAL second Stocks & Shares ISA account via `TRADING212_ISA_API_KEY_ID`/`_SECRET_KEY` (Trading212
scopes one key/secret pair PER account); when set, positions are tagged `account: 'isa'` (vs
`'invest'`) and merged into the same list. Writes `data/out/raw-positions.json`, not yet
ticker-resolved (the `stocks-raw-positions` gate validates the hand-off). Records one combined
`work_items` row per calendar day, **written unconditionally even at zero positions** — so this
stage's ledger activity is always real, never mislabeled noop.

## Stage 2 — `stocks-resolve-names` (T413)

Resolves each fetched position's company **name** from Trading212's own instruments-metadata
endpoint (`GET /equity/metadata/instruments`, called **at most once per run**, never per position) —
Trading212-metadata-only, **no OpenFIGI, no ISIN**. The call is routed through the dedicated
`trading212-instruments` service (`src/services/trading212-instruments.service.ts`, T425), which
mechanically enforces the endpoint's documented 1-request-per-50-seconds spacing via
`minIntervalMs` — separate from the `trading212` service's `ratePerMinute` budget, which governs
only the portfolio-fetch endpoint. `NormalizedPosition` gains an optional `name`
field; a miss is a soft skip (logged, `name` left `undefined`) — never fails the stage. Writes
`data/out/named-positions.json` for `stocks-snapshot` to read (the `stocks-named-positions` gate
validates the hand-off). Records one combined ledger row per day, skipped entirely when there's
nothing to resolve.

## Stage 3 — `stocks-snapshot`

A pure report builder — no Trading212/OpenFIGI calls of its own, no credential check. Reads
`named-positions.json` (written by `stocks-resolve-names`) and writes `data/out/portfolio.json` +
`data/out/portfolio.md`. `portfolio.md` shows a **"Company name"** column (`p.name ?? '—'`) instead of
a resolved ticker — the resolution work now lives entirely in `stocks-resolve-names` (T414 removed
this stage's now-redundant ISIN/OpenFIGI resolution, which used to duplicate the instruments-metadata
call `stocks-resolve-names` already makes). Records one combined ledger row per day (skipped
entirely when there's nothing to record). Declares no `inputKeys()` — not limitable, no Run-limit box.

## Stage 4 — `stocks-watch`

Reads the snapshot and, every run, computes every position's gain since average buy price and writes
to the ledger **unconditionally** — so a quiet run with nothing breaching still shows real ledger
activity, never a stale noop mislabel. A position is a **fresh** breach (≥30% and not already
notified) tracked on a separate `<account:ticker>::notified` ledger key (distinct from the per-run
check key) — set on a fresh breach, left untouched while staying above 30%, and reset when it drops
back below (so a later re-crossing is fresh again). Fresh breaches this run go to
`data/out/fresh-breaches.json`.

## Stage 5 — `stocks-notify`

Reads `fresh-breaches.json` and, if non-empty, sends **one** push naming every freshly breaching
position (multiple breaches combine into a single push). Empty is a genuine noop — the only stage in
this DAG where that's correct, since stage 3 always does real work per run.

## Schedule, service, credentials

Runs daily (schedule editable from the dashboard). Services:
`src/services/trading212.service.ts` (portfolio fetch) and
`src/services/trading212-instruments.service.ts` (instruments-metadata lookup, T425).
Credentials: `TRADING212_API_KEY_ID`, `TRADING212_API_SECRET_KEY` (+ optional
`TRADING212_ISA_API_KEY_ID`/`_SECRET_KEY`). **`outputJob: 'stocks-snapshot'`**: the DAG's true terminal
stage, `stocks-notify`, is a pure notify-trigger with no ledger rows of its own, so the workflow
manifest points the unified Output section at `stocks-snapshot`'s ledger instead.

## Distinct from `stock-digest`

`stock-digest` (separate workflow, `src/workflows/stock-digest/`) is a weekly Claude-narrated summary
of holdings/performance/sector breakdown — it does NOT read this workflow's output; it fetches its own
independent Trading212 snapshot via the same shared `src/services/trading212.service.ts`. See
`src/workflows/stock-digest/CLAUDE.md`.
