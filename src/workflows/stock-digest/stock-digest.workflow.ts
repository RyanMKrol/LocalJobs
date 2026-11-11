import type { WorkflowDefinition } from '../../core/types.js';

/**
 * stock-digest: a weekly Claude-narrated markdown summary of current stock
 * holdings, performance movers, and a sector breakdown. Separate from
 * `stocks-sync`, which snapshots positions daily and alerts on a threshold
 * breach. NOT limitable: no stage declares inputKeys().
 *
 * Trading212 access is strictly read-only: GET requests only, never an order, a
 * transfer or an account change (see the root CLAUDE.md and src/services/CLAUDE.md).
 *
 * No dependency on `stocks-sync`, on purpose: this workflow fetches its OWN
 * Trading212 snapshot instead of reading `stocks-sync`'s
 * `data/out/portfolio.json`. Both call the shared
 * `src/services/trading212.service.ts`. The Monday 08:00 schedule happens to
 * fall after `stocks-sync`'s daily 07:00 run, but nothing relies on that order.
 *
 * Four stages (artifact types in contracts.ts):
 *
 * 1. `stock-portfolio-fetch` fetches the Invest positions (and ISA, if its key
 *    pair is set) and writes `data/out/raw-portfolio.json`. No resolution.
 * 2. `stock-portfolio-snapshot` reads that file and adds each position's ISIN
 *    (one Trading212 instruments-metadata call per run) and real-world ticker
 *    (OpenFIGI), best effort, then writes `data/out/portfolio.json`. The
 *    resolved ticker matters: the next stage queries Finnhub with it.
 * 3. `stock-sector-lookup` finds each held ticker's industry through the Finnhub
 *    company-profile API, once per ticker (tracked in the work_items ledger),
 *    and keeps the map in `data/out/sectors.json`. It always commits a map,
 *    empty if nothing has ever been resolved.
 * 4. `stock-digest-build` takes TWO inputs from two different stages, the
 *    portfolio from stage 2 and the sector map from stage 3, so it has an edge
 *    to each and starts only when both have succeeded. It writes
 *    `data/out/stock-digest-<weekKey>.md`. The digest leaves out its
 *    diversification section when no ticker has an industry, and no digest is
 *    written (a warning, not a failure) when the portfolio is empty.
 *
 * No stage sends a push of its own.
 *
 * Ledger: only `stock-sector-lookup` (one row per ticker) and
 * `stock-digest-build` (one row per ISO week, pointing at that week's file)
 * write rows. Both pass the SAME `weekKey(now)`
 * (`src/workflows/stock-digest/lib.ts`) as an explicit `rootKey`. The fetch and
 * snapshot stages write no ledger rows: their declared outputs are what the
 * run page shows.
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
