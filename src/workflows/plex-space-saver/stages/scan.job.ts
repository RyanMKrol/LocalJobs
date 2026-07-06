import type { JobDefinition } from '../../../core/types.js';
import { runScan } from './scan.js';

const job: JobDefinition = {
  name: 'plex-space-saver-scan',
  description: 'Audits the Plex movie and TV libraries to show where library disk space is going, ' +
    'writing a single biggest-first breakdown of titles by size. Each movie is its own row, and each ' +
    'TV show is one row summing every episode across every season, so the granularity is per-title, ' +
    'not per-file. Size comes directly from the Plex API\'s Media.Part.size field on each item, never ' +
    'from walking the filesystem. The scan re-reads the whole library fresh every run — it is an audit, ' +
    'not an incremental build — with idempotency handled separately via the work_items ledger keyed by ' +
    'ISO calendar week, so a manual re-run in the same week regenerates that week\'s breakdown instead ' +
    'of duplicating it. The output is strictly informational: it never flags, ranks by staleness, or ' +
    'suggests anything for deletion, leaving that judgment entirely to the owner.',
  timeoutMs: 300_000,
  maxRetries: 3,
  async run(ctx) {
    await runScan(ctx);
  },
};

export default job;
