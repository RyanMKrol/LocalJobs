import type { WorkflowDefinition } from '../../core/types.js';

/**
 * Stocks-sync: pull the owner's current open equity positions from Trading212 and
 * write a local snapshot. No DynamoDB.
 *
 * Trading212 access is strictly read-only: GET requests only, never an order, a
 * transfer or an account change (see the root CLAUDE.md and src/services/CLAUDE.md).
 *
 * Five stages in a line. Each one reads what the stage before it committed in the
 * same run (artifact types in contracts.ts):
 *
 * 1. `stocks-fetch` calls Trading212's read-only portfolio endpoint for the Invest
 *    account (and the ISA account, if TRADING212_ISA_API_KEY_ID/_SECRET_KEY are
 *    set), tags each position by account, and writes data/out/raw-positions.json.
 *    The file is written on every run, even with zero positions.
 *
 * 2. `stocks-resolve-names` fills in each position's company name from Trading212's
 *    own instruments-metadata endpoint (at most one call per run, no OpenFIGI, no
 *    ISIN). A miss is logged and `name` is left unset. Writes
 *    data/out/named-positions.json.
 *
 * 3. `stocks-snapshot` makes no network call. It writes data/out/portfolio.json and
 *    data/out/portfolio.md (a table with a "Company name" column). This is the
 *    workflow's product, so the stage is marked `product: true` and the dashboard's
 *    Output section shows the portfolio and its report.
 *
 * 4. `stocks-watch` computes every position's gain since its average buy price and
 *    writes the positions that newly crossed the threshold (STOCKS_WATCH_BREACH_PCT,
 *    default 30) to data/out/fresh-breaches.json, an empty array on a normal day.
 *
 * 5. `stocks-notify` sends ONE push naming every fresh breach, then marks each as
 *    announced. With nothing to announce it sends nothing. It commits a small
 *    digest of what it announced either way.
 *
 * Stages 1 to 3 write no ledger rows: their declared outputs are what the run page
 * shows. The only ledger is under the job name `stocks-watch`. Its
 * `<account>:<ticker>::notified` rows record which breaches have been announced:
 * set by `stocks-notify` after a successful push, reset by `stocks-watch` when the
 * gain drops back below the threshold, so a later re-crossing alerts again.
 * `stocks-watch` also re-records a `<account>:<ticker>` row with the latest gain
 * for every position on every run.
 *
 * Runs daily at 07:00 (schedule editable from the dashboard). Not limitable: no
 * stage declares inputKeys().
 */
const workflow: WorkflowDefinition = {
  name: 'stocks-sync',
  category: 'regular-maintenance',
  description:
    'Fetch the owner\'s Trading212 open equity positions (read-only), write a local ' +
    'portfolio.json + portfolio.md snapshot, and push a one-time alert when a position rises ' +
    '30%+ above its average buy price.',
  idempotencyNote: 'This workflow re-checks your full portfolio fresh every run (nothing is skipped) and only tracks which price-breach alerts have already been sent, so you\'re never re-alerted about the same breach until it resets by dropping back below the threshold first.',
  schedule: '0 7 * * *',
  maxConcurrency: 1,
  jobs: [
    { job: 'stocks-fetch' },
    { job: 'stocks-resolve-names', dependsOn: ['stocks-fetch'] },
    { job: 'stocks-snapshot', dependsOn: ['stocks-resolve-names'] },
    { job: 'stocks-watch', dependsOn: ['stocks-snapshot'] },
    { job: 'stocks-notify', dependsOn: ['stocks-watch'] },
  ],
};

export default workflow;
