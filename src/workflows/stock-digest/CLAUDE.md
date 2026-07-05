# CLAUDE.md — src/workflows/stock-digest/

Weekly, Claude-narrated markdown summary of the owner's current stock holdings — performance movers
and a sector/diversification breakdown. Runs Monday 08:00. Markdown-only output; no push notification
is ever sent (mirrors `listening-digest`). Not limitable (nothing to fan out over).

**Distinct from `stocks-sync`, which only snapshots positions + sends threshold-breach alerts** —
`stock-digest` is its own workflow, own schedule, own concerns (a narrated report, not a live watch).

## ⚠️ No inter-workflow dependency — deliberate, do not "simplify" this back

`stock-digest` does **not** read `stocks-sync`'s `data/out/portfolio.json`. It fetches its **own**
Trading212 snapshot independently, via the same shared, top-level `src/services/trading212.service.ts`
that `stocks-sync` also calls. This is a shared **service** dependency (the normal, intended pattern for
cross-job reuse in this repo) — not a coupling between the two workflows. Each calls the shared service
with its own credentials each run; neither reads the other's output file. Don't reintroduce a read of
`stocks-sync`'s output file here even though it may look like an obvious "avoid refetching" shortcut.

## DAG (4 stages, one genuine fan-in)

```
stock-portfolio-fetch ──▶ stock-portfolio-snapshot ──▶ stock-sector-lookup ──▶ stock-digest-build
                                                     └───────────────────────────────▲
```

**Stage 1 (`stock-portfolio-fetch`, T415)** fetches Invest + optional ISA positions from Trading212
(same credentials as `stocks-sync`: `TRADING212_API_KEY_ID`/`_SECRET_KEY`,
`TRADING212_ISA_API_KEY_ID`/`_SECRET_KEY`), normalizes + tags each by account, and writes
`data/out/raw-portfolio.json`. No ISIN/ticker resolution here. Records ONE combined ledger row per
run, keyed by ISO week, **unconditionally** (even at zero fetched positions — a zero-position fetch
is still a real, worth-recording observation).

**Stage 2 (`stock-portfolio-snapshot`, T415 split from the old combined fetch+resolve stage —
mirrors `stocks-sync`'s `stocks-fetch`/`stocks-snapshot` split)** reads stage 1's
`raw-portfolio.json` and resolves each position's ISIN + real-world ticker via OpenFIGI (same
resolution logic `stocks-sync` uses, from the shared `src/services/trading212.service.ts`) —
**genuinely load-bearing here** (unlike `stocks-sync`, where the equivalent resolution became purely
cosmetic): `stock-sector-lookup` actually prefers the resolved ticker as its Finnhub query symbol.
Writes `data/out/portfolio.json`. A missing/empty portfolio (Trading212 returns nothing, or
credentials unset) soft-skips downstream with a clear WARN, not a crash.

**Stage 3 (`stock-sector-lookup`)** resolves each held ticker's industry via the Finnhub
company-profile API (`FINNHUB_API_KEY`, `src/services/finnhub.service.ts`), writing
`data/out/sectors.json`. **Prefers the OpenFIGI-resolved real-world ticker over the raw Trading212
ticker as the Finnhub query symbol** when available (`resolvedByTicker` map keyed by the position's
original ticker) — falls back to a crude string-strip (`toFinnhubSymbol`, drops a trailing `_EQ` +
2-letter market/country code) only when no `resolvedTicker` exists. This matters because Trading212's
raw ticker format goes stale after a company rename and Finnhub silently returns an empty profile for
a dead symbol. Idempotent per ticker via the `work_items` ledger — a resolved industry is never
re-queried; an unresolved lookup is recorded `'failed'` so it retries (capped, surfaces on the Stuck
tile if it never resolves). `FINNHUB_API_KEY` unset soft-skips the whole stage (clear WARN) — the
digest's diversification section is simply omitted that run.

**Stage 4 (`stock-digest-build`)** — a genuine fan-in, reading BOTH the portfolio snapshot and (once
stage 3 has run) the sector map. Computes, in code (never left to Claude): each position's gain since
average buy price and share of total portfolio value, ranks top winners/losers, and groups portfolio
value by resolved Finnhub industry (tickers with no resolved sector excluded from the breakdown; the
whole diversification section omitted if `sectors.json` is missing/empty). Feeds a structured JSON
facts object to `runClaude` asking for a holdings section, a performance section, and — when sector
data exists — a diversification section (explicitly noted as Finnhub's own classification, not formal
GICS). The raw facts JSON is persisted to `data/out/stock-digest-facts-<weekKey>.json` **before** the
Claude call, so it's on disk for debugging even if that call throws. After narration, a soft ticker
cross-check (`extractCandidateTickers`/`findUnknownTickers`) scans the markdown for ticker-shaped
tokens not in `facts.holdings` and not a known non-ticker acronym (`KNOWN_NON_TICKER_TOKENS` — a living
stoplist, e.g. `ISA`/`USD`/`ETF`) — logs one `warn:` line naming any found; never throws or changes the
outcome. Output: `data/out/stock-digest-<weekKey>.md` (ISO week key, e.g. `2026-W27`). Idempotent per
ISO week via the `work_items` ledger — a manual re-run the same week regenerates that week's file.

## Ledger lineage — all 4 stages share the same root key

Every stage's `markWorkItem` call passes the **same** `weekKey(now)` (`lib.ts`) as `rootKey` — stages 1
and 2 each collapse to ONE combined ledger row per week (not one per position); stage 3's per-ticker
rows and stage 4's own week-keyed row both pass that identical value explicitly. This is deliberate
(correct for both idempotency and lineage), not an oversight to "fix" into per-item keys.

**Dashboard display is NOT the generic joined Input→Output panel.** Because stage 3 genuinely fans out
(many tickers) and stage 4 genuinely fans in (aggregates both predecessors), pairing "one input" to
"one output" by `root_key` would either collapse real data away or show a confusing mismatched union.
This workflow's run page instead renders `StageIoPanel` (`dashboard/app/components/StageIoLists.tsx`) —
per stage, two independent, un-paired lists (predecessor(s)' ledger rows as Inputs, its own as
Outputs) — gated to `stock-digest` only; every other workflow keeps the generic joined `IoPanel`.

## Files

`config.ts` (`stockDigestConfig`, `reportPathFor`/`factsPathFor`/`sectorsJsonPath`/`portfolioJsonPath`/
`rawPortfolioJsonPath`), `contracts.ts` (gate contracts for the 4 stage boundaries), `lib.ts`
(`weekKey`). Credentials: `TRADING212_API_KEY_ID`/`_SECRET_KEY` (+ optional ISA pair),
`FINNHUB_API_KEY`. Model: `STOCK_DIGEST_CLAUDE_MODEL` (default a Sonnet 5 id) at effort
`STOCK_DIGEST_CLAUDE_EFFORT` (default `medium`), via the shared `claude-cli` service.
