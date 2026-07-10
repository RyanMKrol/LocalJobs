import type { JobDefinition } from '../../../core/types.js';
import { runScan } from './scan.js';

const job: JobDefinition = {
  name: 'overrides-audit-scan',
  description: 'Audits every dashboard override currently set across services (rate/quota limits), ' +
    'workflows (schedule, max concurrency, notify-on-completion), and jobs (timeout) — anything with ' +
    'its "_overridden" flag set to 1 — and reports which of those have either an unknown override age ' +
    '(set before this feature existed) or have been live and unchanged for 2+ weeks. This is purely a ' +
    'report: it never sends a push notification, never writes to the ideas inbox, and never patches any ' +
    'manifest or service-definition file — folding a stable override into its code default and clearing ' +
    'the flag stays a fully manual step the owner does by hand. Idempotent per ISO calendar week via the ' +
    'work_items ledger, so a manual re-run in the same week regenerates that week\'s report instead of ' +
    'duplicating it.',
  timeoutMs: 60_000,
  maxRetries: 3,
  async run(ctx) {
    await runScan(ctx);
  },
};

export default job;
