import { defineStage } from '../../../engine/index.js';
import { plexSpaceSaverConfig } from '../config.js';
import { sizeBreakdown } from '../contracts.js';
import { runScan } from './scan.js';

export default defineStage({
  name: 'plex-space-saver-scan',
  description: 'Audits the Plex movie and TV libraries to show where library disk space is going, ' +
    'writing a single biggest-first breakdown of titles by size. Each movie is its own row, and each ' +
    'TV show is one row summing every episode across every season, so the granularity is per-title, ' +
    'not per-file. Size comes directly from the Plex API\'s Media.Part.size field on each item, never ' +
    'from walking the filesystem. The scan re-reads the whole library fresh every run — it is an audit, ' +
    'not an incremental build — and rewrites data/out/size-breakdown.json, its one declared output. ' +
    'The output is strictly informational: it never flags, ranks by staleness, or ' +
    'suggests anything for deletion, leaving that judgment entirely to the owner.',
  timeoutMs: 300_000,
  maxRetries: 3,
  // Rebuilt from Plex on every run: a run that returned without writing it fails.
  outputs: {
    breakdown: { artifact: sizeBreakdown, location: () => plexSpaceSaverConfig.breakdownOut },
  },
  async run(ctx) {
    await runScan(ctx);
  },
});
