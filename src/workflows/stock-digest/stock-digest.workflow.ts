import type { WorkflowDefinition } from '../../core/types.js';

/**
 * stock-digest: weekly Claude-narrated markdown summary of current stock
 * holdings, performance movers, and a sector/diversification breakdown,
 * DISTINCT from `stocks-sync` (which only snapshots positions +
 * threshold-alerts). NOT limitable: nothing to fan out over.
 *
 * Scheduled for Monday 08:00 — historically AFTER `stocks-sync`'s daily
 * '0 7 * * *' run, back when this workflow read stocks-sync's snapshot; kept
 * at the same time since it's still a sensible weekly cadence, though it no
 * longer depends on that ordering (see below).
 *
 * NO inter-workflow dependency (T382, reverses the T337 cross-workflow-read
 * pattern): stock-digest fetches its OWN Trading212 snapshot rather than
 * reading `stocks-sync`'s `data/out/portfolio.json`. Four-stage DAG (T415 split
 * the old combined fetch+resolve stage in two, mirroring `stocks-sync`):
 * `stock-portfolio-fetch` (own credentials read, fetches Invest + optional ISA
 * positions, writes `data/out/raw-portfolio.json`, no resolution) feeds
 * `stock-portfolio-snapshot` (reads raw-portfolio.json, resolves each position's
 * ISIN + real-world ticker via OpenFIGI, T373, via the shared
 * `src/services/trading212.service.ts` also used by `stocks-sync` — genuinely
 * load-bearing here, unlike `stocks-sync`'s now-cosmetic-only resolution, since
 * `stock-sector-lookup` actually queries Finnhub with the resolved ticker),
 * which fans out to BOTH `stock-sector-lookup` (resolves each held ticker's
 * industry via the Finnhub company-profile API — preferring the
 * OpenFIGI-resolved real-world ticker over the raw/possibly-stale Trading212
 * ticker — idempotent per ticker via the work_items ledger, writes
 * data/out/sectors.json) AND `stock-digest-build` (a genuine fan-in: it reads
 * BOTH the portfolio snapshot and, once `stock-sector-lookup` has run, the
 * sector map). The report degrades gracefully (omits the diversification
 * section) if sectors.json is missing or empty, and soft-skips (WARN + clean
 * return, no crash) if the portfolio snapshot is empty.
 *
 * Markdown-only output — no push notification is sent, mirroring
 * `listening-digest`.
 *
 * Shared lineage root (follow-up to T382): every stage's `markWorkItem` call
 * uses the SAME `weekKey(now)` (`src/workflows/stock-digest/lib.ts`) as its `rootKey` —
 * `stock-portfolio-fetch` and `stock-portfolio-snapshot` each collapse to ONE
 * combined ledger row per run (keyed by that week, not one row per position),
 * and both `stock-sector-lookup` (per-ticker keys) and `stock-digest-build` (its
 * own week-keyed row) pass that same value as `rootKey` explicitly. This is
 * genuinely correct for ledger POTENCY/idempotency (one row per week per
 * snapshot stage; the same root threaded through for lineage) — kept
 * deliberately, not reverted.
 *
 * Decoupled dashboard display, NOT a joined table (second follow-up to T382): the
 * generic workflow-run Input → Output panel pairs "one input" to "one output" by
 * matching root_key, which — given `stock-sector-lookup`'s genuine per-ticker
 * fan-out and `stock-digest-build`'s genuine many-to-one aggregation — either
 * collapsed real data away or showed a confusing union of unmatched rows. This
 * workflow's run page instead renders `StageIoPanel`
 * (`dashboard/app/components/StageIoLists.tsx`, backed by `GET
 * /workflow-runs/:id/stage-io` → `stageIoLists` in `src/db/store.ts`): per stage,
 * TWO independent, un-paired lists — its direct predecessor(s)' ledger rows this
 * run as "Inputs", its own ledger rows this run as "Outputs". A genuine 3-ticker
 * fan-out shows as 3 rows, not 1. This was originally gated to `stock-digest`
 * only, but T386 made `StageIoPanel` the default Inputs & Outputs panel for EVERY
 * workflow's run page, and T389 deleted the old generic joined `IoPanel` entirely
 * — so `StageIoPanel` is now the only panel, no longer an alternative to anything.
 */
const workflow: WorkflowDefinition = {
  name: 'stock-digest',
  category: 'regular-maintenance',
  description:
    'Weekly markdown digest of stock holdings, performance movers, and a sector/diversification ' +
    'breakdown, narrated by Claude from stock-digest\'s own Trading212 portfolio snapshot + Finnhub ' +
    'industry lookups, written to data/out/.',
  idempotencyNote: 'There\'s no per-item tracking here — this workflow tracks only which calendar week\'s digest has been generated (plus which stock tickers already have a resolved industry, so those aren\'t re-looked-up), so re-running it the same week just regenerates that week\'s report in place.',
  schedule: '0 8 * * 1',
  maxConcurrency: 1,
  jobs: [
    { job: 'stock-portfolio-fetch' },
    { job: 'stock-portfolio-snapshot', dependsOn: ['stock-portfolio-fetch'] },
    { job: 'stock-sector-lookup', dependsOn: ['stock-portfolio-snapshot'] },
    { job: 'stock-digest-build', dependsOn: ['stock-portfolio-snapshot', 'stock-sector-lookup'] },
  ],
};

export default workflow;
