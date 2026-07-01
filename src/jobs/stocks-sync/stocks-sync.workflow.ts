import type { WorkflowDefinition } from '../../core/types.js';

/**
 * Stocks-sync: pull the owner's current open equity positions from Trading212 via
 * a strictly read-only integration and write a local snapshot — no DynamoDB,
 * matching this repo's local-markdown-first direction.
 *
 * Stage 1 (only stage for now), `stocks-snapshot`, calls Trading212's read-only
 * portfolio endpoint, normalizes each position into a broker-agnostic shape, and
 * writes data/out/portfolio.json (structured) + data/out/portfolio.md (human-
 * readable, with a price-difference column). Idempotent per ticker via the
 * work_items ledger.
 *
 * Runs daily (schedule editable from the dashboard).
 */
const workflow: WorkflowDefinition = {
  name: 'stocks-sync',
  description:
    'Fetch the owner\'s Trading212 open equity positions (read-only) and write a local ' +
    'portfolio.json + portfolio.md snapshot.',
  schedule: '0 7 * * *',
  maxConcurrency: 1,
  jobs: [{ job: 'stocks-snapshot' }],
};

export default workflow;
