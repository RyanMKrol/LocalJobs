# CLAUDE.md — src/workflows/stock-digest/

A weekly, Claude-narrated markdown summary of the owner's current stock holdings: the positions,
the biggest movers, and a sector breakdown. Runs Monday 08:00 (`0 8 * * 1`). The output is
markdown only. No stage sends a push of its own; the only notification is the engine's usual
run-end one. Not limitable: no stage declares `inputKeys()`.

It is separate from `stocks-sync`, which snapshots positions daily and alerts on a threshold
breach. `stock-digest` has its own schedule and its own job: a narrated report, not a live watch.

## 🚫 Broker access is read-only, always

Every Trading212 call this workflow makes is a GET. It must never place, cancel or modify an
order, make a transfer, or change anything on the account. This is the repo-wide rule (root
`CLAUDE.md`, "Broker / trading APIs are READ-ONLY, always", repeated in `src/services/CLAUDE.md`),
and it is a hard constraint, not a default. If a change here would need a mutating call, stop and
flag it instead of making the call.

## ⚠️ No dependency on `stocks-sync`: deliberate, do not "simplify" this back

`stock-digest` does **not** read `stocks-sync`'s `data/out/portfolio.json`. It fetches its **own**
Trading212 snapshot through the same shared, top-level `src/services/trading212.service.ts` that
`stocks-sync` calls. Sharing a service is the normal way to reuse code across workflows in this
repo. It is not a coupling between the two: each calls the service with its own credentials read
on each run, and neither reads the other's output file. Do not reintroduce a read of
`stocks-sync`'s output here, even though it looks like an easy way to avoid a second fetch.

## DAG (4 stages, the last one has two inputs)

```
stock-portfolio-fetch ──▶ stock-portfolio-snapshot ──▶ stock-sector-lookup ──▶ stock-digest-build
                                                     └───────────────────────────────▲
```

**Stage 1 (`stock-portfolio-fetch`)** fetches the Invest positions, and the ISA positions when
the ISA key pair is set, from Trading212 through the `trading212` service. It uses the same
credentials as `stocks-sync` (`TRADING212_API_KEY_ID`/`_SECRET_KEY`, optional
`TRADING212_ISA_API_KEY_ID`/`_SECRET_KEY`), tags each position by account, and writes
`data/out/raw-portfolio.json`. It resolves nothing. The file is written on every run, even with
zero positions. The stage fails if the main key pair is not set.

**Stage 2 (`stock-portfolio-snapshot`)** reads the raw portfolio and tries to give each position
an ISIN and a current real-world ticker (`resolvedTicker`). It makes one call per run to
Trading212's instruments-metadata endpoint, through the `trading212-instruments` service
(`src/services/trading212-instruments.service.ts`), which spaces requests 50 seconds apart
because the endpoint is documented as one request per 50 seconds. That gives the ISIN. Each
distinct ISIN is then looked up through the `openfigi` service (`OPENFIGI_API_KEY` is optional
and only raises the free limits). The resolution helpers (`resolveTickers`,
`resolveOpenFigiTickersBatched`) live in `src/services/trading212.service.ts`; this stage is their
only caller. Resolution is best effort: a miss for one position, or a failure of the whole step,
is logged as a warning and the positions are written without those fields. It writes
`data/out/portfolio.json` on every run. The stage fails if the main Trading212 key pair is not
set.

The resolved ticker matters here: `stock-sector-lookup` prefers it when it queries Finnhub.

**Stage 3 (`stock-sector-lookup`)** finds each held ticker's industry through the Finnhub
company-profile API (`FINNHUB_API_KEY`, `src/services/finnhub.service.ts`) and keeps the results
in `data/out/sectors.json`, a ticker to industry map that grows over many runs.

- It queries Finnhub with the position's `resolvedTicker` when there is one. Otherwise it strips
  the raw Trading212 ticker (`toFinnhubSymbol` drops a trailing `_EQ` and then a 2-letter market
  code). The preference matters because Trading212's raw ticker goes stale after a company
  rename, and Finnhub returns an empty profile for a dead symbol instead of an error.
- A ticker with a resolved industry is done and is never queried again. A lookup that returns no
  industry, or throws, is recorded `failed` with its attempt counted.
- A ticker that fails makes the stage's run fail. The map is saved first, then the stage throws
  if any ticker failed this run. The job's retries (3) re-attempt only the failed tickers. A
  ticker that has failed 3 times stops being retried and shows on the Stuck tile, at which point
  the stage passes and the digest still builds in the same run. Attempts are counted across runs
  because, before that, every failure was recorded as attempt 1 and an unclassifiable ticker was
  retried on every run for ever without surfacing.
- With `FINNHUB_API_KEY` unset, or with nothing held, the stage logs a warning and makes no
  lookups. It still commits its output: an empty map if no `sectors.json` exists yet, otherwise
  the existing map carried forward.

**Stage 4 (`stock-digest-build`)** takes two inputs from two different stages: the portfolio from
stage 2 and the sector map from stage 3. It starts only when both have succeeded. All the numbers
are computed in code, never left to Claude: each position's gain since average buy price and its
share of total portfolio value, the top winners and losers (`moversCount`, 3 each), and portfolio
value grouped by Finnhub industry. Tickers with no industry are left out of the breakdown, and
the whole diversification section is left out when no ticker has one.

The facts are saved to `data/out/stock-digest-facts-<weekKey>.json` **before** the Claude call,
so they are on disk for debugging even if that call throws. They are then given to `runClaude`,
which is asked for a holdings section, a performance section and, when there is sector data, a
diversification section that says the grouping is Finnhub's own classification and not formal
GICS. After narration a soft cross-check (`extractCandidateTickers`/`findUnknownTickers`) scans
the markdown for ticker-shaped tokens that are neither in `facts.holdings` nor in
`KNOWN_NON_TICKER_TOKENS` (a stoplist to add to as false positives turn up, such as `ISA`, `USD`,
`ETF`). It logs one warning naming any it finds and never changes the outcome.

The digest goes to `data/out/stock-digest-<weekKey>.md` (ISO week key, for example `2026-W27`).
A re-run in the same week rewrites that week's file. Two cases write no digest and leave the
folder as it was: an empty portfolio (a warning), and a Claude usage limit (a warning; the next
run tries again). Any other Claude failure fails the stage.

## How the stages hand data to each other (ports)

A ports workflow (see "Ports" in the root `CLAUDE.md`; artifact types in `contracts.ts`):

| Stage | Inputs | Outputs |
|---|---|---|
| `stock-portfolio-fetch` | none | `raw` (`stock-raw-portfolio`, `raw-portfolio.json`) |
| `stock-portfolio-snapshot` | `raw` | `portfolio` (`stock-digest-portfolio`, `portfolio.json`) |
| `stock-sector-lookup` | `portfolio` | `sectors` (`stock-sectors`, `sectors.json`, cumulative) |
| `stock-digest-build` | `portfolio` (from the snapshot), `sectors` (from the lookup) | `digests` (`stock-digests`, the weekly `stock-digest-<weekKey>.md` files in `data/out`, cumulative) |

The manifest gives the build stage both edges (`dependsOn: ['stock-portfolio-snapshot',
'stock-sector-lookup']`), one per input. The two cumulative outputs are stores that grow, so a
run that adds nothing records them as carried forward instead of failing. The lookup stage always
commits a map, even an empty one. It used to return without writing, and the build stage then
read whatever file happened to be there. The digests share `data/out` with the other files, so
the artifact type names its own files (`files`): the weekly `.md` files, not the facts JSON.

## The ledger

`stock-portfolio-fetch` and `stock-portfolio-snapshot` write no ledger rows. The run page shows
their declared outputs. The other two stages each keep one:

| Job name | Key | Row |
|---|---|---|
| `stock-sector-lookup` | the raw Trading212 ticker | `success` with the industry and the symbol queried, or `failed` with the error. This is what makes a ticker a one-time lookup and what counts its attempts. |
| `stock-digest-build` | the ISO week key | `success` with the path of that week's markdown file. A re-run in the same week re-records the same row. |

Both stages pass the **same** `weekKey(now)` (`lib.ts`) as an explicit `rootKey`: stage 3 on each
per-ticker row, stage 4 on its own week row. An explicit `rootKey` does not need a row with that
key to exist, so nothing is lost by stages 1 and 2 writing no rows. This is deliberate. Do not
"fix" it into per-item root keys.

The run page shows all of this in `StageIoPanel`, the one Inputs & Outputs panel every workflow
uses: per stage, the artifacts it was handed and committed, and the ledger rows its own attempts
changed.

## Timeouts, files, config

- Timeouts: 60 seconds for stages 1 and 2, 120 seconds for the sector lookup, 300 seconds for the
  build. Every stage has 3 retries. `maxConcurrency: 1`.
- `config.ts`: `stockDigestConfig`, `reportPathFor`, `factsPathFor`, `sectorsJsonPath`,
  `portfolioJsonPath`, `rawPortfolioJsonPath`.
- `contracts.ts`: the artifact types the stages exchange.
- `lib.ts`: `weekLabel`, a re-export of `weekKey` from the shared `src/core/dates.ts`, and
  `readPortfolio` (a tolerant reader for a positions file, also imported by `stocks-sync`'s
  `stocks-watch`).
- Credentials: `TRADING212_API_KEY_ID`/`_SECRET_KEY` (plus the optional ISA pair),
  `FINNHUB_API_KEY`, and optionally `OPENFIGI_API_KEY`.
- Model: `STOCK_DIGEST_CLAUDE_MODEL` (default `claude-sonnet-5`) at effort
  `STOCK_DIGEST_CLAUDE_EFFORT` (default `medium`), through the shared `claude-cli` service.
