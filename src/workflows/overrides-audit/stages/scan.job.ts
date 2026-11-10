import { defineStage } from '../../../engine/index.js';
import { overridesAuditConfig } from '../config.js';
import { staleOverridesReport } from '../contracts.js';
import { runScan } from './scan.js';

export default defineStage({
  name: 'overrides-audit-scan',
  description: 'Audits every dashboard override currently set across services (rate/quota limits), ' +
    'workflows (schedule, max concurrency, notify-on-completion), and jobs (timeout) — anything with ' +
    'its "_overridden" flag set to 1 — and reports which of those have either an unknown override age ' +
    '(set before this feature existed) or have been live and unchanged for 2+ weeks. This is purely a ' +
    'report: it never sends a push notification, never writes to the ideas inbox, and never patches any ' +
    'manifest or service-definition file — folding a stable override into its code default and clearing ' +
    'the flag stays a fully manual step the owner does by hand. It re-scans from scratch on every run ' +
    'and rewrites data/out/stale-overrides.json, its one declared output.',
  timeoutMs: 60_000,
  maxRetries: 3,
  // Rebuilt on every run: a run that returned without writing it fails.
  outputs: {
    report: { artifact: staleOverridesReport, location: () => overridesAuditConfig.reportOut },
  },
  async run(ctx) {
    await runScan(ctx);
  },
});
