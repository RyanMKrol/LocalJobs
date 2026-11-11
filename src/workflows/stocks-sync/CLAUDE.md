# CLAUDE.md — src/workflows/stocks-sync/

Pulls the owner's current open equity positions from Trading212
(https://docs.trading212.com/api) via a **strictly read-only** integration (GET-only, HTTP Basic
auth, see `src/services/CLAUDE.md`) and writes a local snapshot: `data/out/portfolio.json` (a
broker-agnostic array of `{ ticker, quantity, averageBuyPrice, currentPrice, currentValue, account,
name? }`) and `data/out/portfolio.md` (one row per position, with an Account column and the price
difference since purchase as both an absolute amount and a percentage). It then pushes a one-time
alert when a position rises far enough above its average buy price. No DynamoDB.

Five stages in a line:
`stocks-fetch → stocks-resolve-names → stocks-snapshot → stocks-watch → stocks-notify`.

## 🚫 Broker access is read-only, always

Every Trading212 call this workflow makes is a GET. It must never place, cancel or modify an
order, make a transfer, or change anything on the account. This is the repo-wide rule (root
`CLAUDE.md`, "Broker / trading APIs are READ-ONLY, always", repeated in `src/services/CLAUDE.md`),
and it is a hard constraint, not a default. If a change here would need a mutating call, stop and
flag it instead of making the call.

## Stage 1: `stocks-fetch`

Fetches the open positions of the Invest account from Trading212 through the `trading212`
service and tags each `account: 'invest'`. If `TRADING212_ISA_API_KEY_ID` and
`TRADING212_ISA_API_SECRET_KEY` are both set (Trading212 issues one key pair per account), it also
fetches the Stocks & Shares ISA account, tags those `account: 'isa'`, and merges them into the same
list. It resolves nothing. Writes `data/out/raw-positions.json` on every run, even with zero
positions. Fails if `TRADING212_API_KEY_ID` or `TRADING212_API_SECRET_KEY` is not set.

## Stage 2: `stocks-resolve-names`

Fills in each position's company `name` from Trading212's own instruments-metadata endpoint
(`GET /equity/metadata/instruments`), called at most once per run, never per position. No OpenFIGI
and no ISIN are involved. The call goes through the `trading212-instruments` service
(`src/services/trading212-instruments.service.ts`), which spaces requests 50 seconds apart
(`minIntervalMs`) because that endpoint is documented as one request per 50 seconds. That is a
separate budget from the `trading212` service's `ratePerMinute`, which covers the portfolio
endpoint only. A ticker with no match is logged as a warning and its `name` is left unset; it
never fails the stage. Writes `data/out/named-positions.json`. With no positions it writes the
empty list and makes no metadata call.

## Stage 3: `stocks-snapshot` (the product stage)

A report builder with no network calls and no credential check. It reads the named positions and
writes `data/out/portfolio.json` and `data/out/portfolio.md`, both on every run, including when
nothing is held. The markdown table has a "Company name" column that shows an em-dash placeholder
when stage 2 found no name. All name resolution happens in stage 2.

This stage is marked `product: true`. The two stages after it only watch the portfolio and
sometimes send a push, so the dashboard's Output section shows what this stage commits (the
portfolio and its markdown report).

## Stage 4: `stocks-watch`

Reads the portfolio and computes each position's gain since its average buy price. The breach
threshold comes from `STOCKS_WATCH_BREACH_PCT` (default 30; an unset, invalid or non-positive
value falls back to 30, see `stocksSyncConfig.breachThresholdPct` in `config.ts`).

A position is a fresh breach when its gain is at or above the threshold and it has not already
been announced. Fresh breaches go to `data/out/fresh-breaches.json`, which is written on every
run and is an empty array on a normal day.

## Stage 5: `stocks-notify`

Reads the fresh breaches. If there are any, it sends one push that names all of them (several
breaches share a single push), and only after the push has gone out does it mark each one as
announced. If the push fails the stage throws, the run fails, and nothing is marked, so the next
run finds the same breaches fresh again. With an empty list it sends nothing. Either way it
commits its `digest` output saying how many positions were announced and which.

## The ledger (job name `stocks-watch`)

`stocks-fetch`, `stocks-resolve-names` and `stocks-snapshot` write no ledger rows. The run page
shows their declared outputs. The only ledger in this workflow is under the job name
`stocks-watch`, and two stages write to it:

| Key | Written by | Meaning |
|---|---|---|
| `<account>:<ticker>::notified` | `stocks-notify` sets it `success` after a successful push. `stocks-watch` resets it to `skipped` when the gain drops back below the threshold. | Whether the current breach has been announced. This is real state: it is what stops a second alert while a position stays above the threshold, and the reset is what lets a later re-crossing alert again. |
| `<account>:<ticker>` | `stocks-watch`, `success` on every run for every position, with `gainPct` and `breaching` in its detail. | The position's latest gain. Nothing reads it back. |

The key includes the account because the same ticker can be held in both accounts
(`positionKey` in `src/services/trading212.service.ts`).

The per-position row dates from when the engine called a stage a no-op if it touched no ledger
row. That check now applies only to limitable workflows, and judges a ports stage on what it
committed, so this workflow no longer depends on the row.

## How the stages hand data to each other (ports)

A ports workflow (see "Ports" in the root `CLAUDE.md`; artifact types in `contracts.ts`):

| Stage | Inputs | Outputs |
|---|---|---|
| `stocks-fetch` | none | `raw` (`stocks-raw-positions`, `raw-positions.json`) |
| `stocks-resolve-names` | `raw` | `named` (`stocks-named-positions`, `named-positions.json`) |
| `stocks-snapshot` | `named` | `portfolio` (`stocks-portfolio`, `portfolio.json`), `report` (`stocks-portfolio-report`, `portfolio.md`) |
| `stocks-watch` | `portfolio` | `breaches` (`stocks-fresh-breaches`, `fresh-breaches.json`, empty on a normal day) |
| `stocks-notify` | `breaches` | `digest` (`stocks-breach-digest`, inline: what was announced) |

Every output is rebuilt on every run, so each stage reads what the previous one committed in
the same run, and a stage that returned without writing its file fails. An empty position list
and an empty breach list are both valid. The three position artifacts share one check: a JSON
array whose entries each have a ticker and an account of `invest` or `isa`.

## Schedule, limits, services, credentials

- Runs daily at 07:00 (`0 7 * * *`, editable from the dashboard). `maxConcurrency: 1`.
- Every stage has a 60 second timeout and 3 retries.
- No stage declares `inputKeys()`, so the workflow is not limitable and has no run-limit box.
- Services: `trading212` (`src/services/trading212.service.ts`, the portfolio fetch) and
  `trading212-instruments` (the instruments-metadata lookup).
- Credentials: `TRADING212_API_KEY_ID`, `TRADING212_API_SECRET_KEY`, and optionally
  `TRADING212_ISA_API_KEY_ID` with `TRADING212_ISA_API_SECRET_KEY`.
- Config: `STOCKS_WATCH_BREACH_PCT`.

## Distinct from `stock-digest`

`stock-digest` (a separate workflow, `src/workflows/stock-digest/`) is a weekly Claude-narrated
summary of holdings, performance and sector breakdown. It does not read this workflow's output.
It fetches its own Trading212 snapshot through the same shared
`src/services/trading212.service.ts`. See `src/workflows/stock-digest/CLAUDE.md`.
