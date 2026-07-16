import type { WorkflowDefinition } from '../../core/types.js';

/**
 * Overrides audit — a single-stage, report-only sweep of every dashboard override
 * currently set across services/workflows/jobs (rate/quota limits, schedule, max
 * concurrency, notify-on-completion, job timeout), surfacing any that's been live
 * and unchanged for 2+ weeks (or is unknown-age) as a candidate to fold into the
 * manifest/service-definition code default. Mirrors `plex-space-saver`'s shape:
 * plain SQLite reads, no LLM, no filesystem/API scraping. RE-SCANS FRESH every
 * run; idempotent per ISO calendar week via the work_items ledger. One stage, so
 * no DAG edge — no gate needed (see src/workflows/CLAUDE.md).
 */
const workflow: WorkflowDefinition = {
  name: 'overrides-audit',
  category: 'regular-maintenance',
  description: 'Reports every dashboard override (service limits, workflow schedule/concurrency/notify, ' +
    'job timeout) that has been live and unchanged for 2+ weeks or has an unknown override age — a ' +
    'reminder to fold a stable value into the manifest/service-definition code default. Report only, ' +
    'never auto-patches anything. Weekly.',
  idempotencyNote: 'There\'s no per-item tracking here — this workflow tracks only which calendar week\'s override report has been generated, so re-running it the same week regenerates that week\'s report in place; it always re-scans every current dashboard override fresh.',
  schedule: '0 7 * * 0',
  jobs: [{ job: 'overrides-audit-scan' }],
};

export default workflow;
