import type { WorkflowDefinition } from '../../core/types.js';

/**
 * Stocks-sync: pull the owner's current open equity positions from Trading212 via
 * a strictly read-only integration and write a local snapshot — no DynamoDB,
 * matching this repo's local-markdown-first direction.
 *
 * Stage 1, `stocks-snapshot`, calls Trading212's read-only portfolio endpoint,
 * normalizes each position into a broker-agnostic shape, and writes
 * data/out/portfolio.json (structured) + data/out/portfolio.md (human-readable,
 * with a price-difference column). Idempotent per ticker via the work_items
 * ledger.
 *
 * Stage 2, `stocks-watch` (depends on stocks-snapshot), reads that snapshot and
 * sends ONE push whenever any position's current price has risen 30% or more
 * above its average buy price since it last crossed that threshold — a
 * "re-scan + notification-log" idempotent stage (mirrors missing-tv-seasons):
 * a fresh breach notifies once, staying above 30% notifies nothing further, and
 * dropping back below 30% resets so a later re-breach notifies again.
 *
 * Runs daily (schedule editable from the dashboard).
 */
const workflow: WorkflowDefinition = {
  name: 'stocks-sync',
  category: 'regular-maintenance',
  description:
    'Fetch the owner\'s Trading212 open equity positions (read-only), write a local ' +
    'portfolio.json + portfolio.md snapshot, and push a one-time alert when a position rises ' +
    '30%+ above its average buy price.',
  schedule: '0 7 * * *',
  maxConcurrency: 1,
  jobs: [
    { job: 'stocks-snapshot' },
    { job: 'stocks-watch', dependsOn: ['stocks-snapshot'] },
  ],
};

export default workflow;
