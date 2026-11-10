import { join } from 'node:path';
import { defineStage } from '../../../engine/index.js';
import { missingMoviesConfig } from '../config.js';
import { franchiseGaps, gapsDigest, gapsReport } from '../contracts.js';
import { runNotify } from './notify.js';

export default defineStage({
  name: 'movie-gaps-notify',
  description: 'Terminal stage of the missing-movies workflow, run once franchise-gaps finishes. It reads franchise-gaps.json, filters out anything the owner has explicitly ignored via the dashboard (checked against the gaps ignore ledger, keyed by TMDB id), and sends a weekly push notification listing the franchise gaps. Idempotency here is a "have I already notified this?" log rather than a work-done ledger: each gap is keyed by TMDB id in the work_items table, so the first run digests the entire current backlog while every later run reports only gaps that are newly detected since the last notification, and an owner-ignored gap is suppressed from all future digests until unignored.',
  timeoutMs: 120_000,
  maxRetries: 3,
  inputs: { gaps: { artifact: franchiseGaps } },
  // The report is rewritten every run; the digest says what this run announced.
  outputs: {
    report: { artifact: gapsReport, location: () => join(missingMoviesConfig.reportDir, 'franchise-gaps.md') },
    digest: { artifact: gapsDigest },
  },
  // An announced gap, as the run page shows it.
  describeItem: (d) => ({
    title: typeof d.name === 'string' ? d.name : String(d.title ?? ''),
    fields: [
      ...(d.year != null ? [{ label: 'Year', value: String(d.year) }] : []),
      ...(typeof d.tmdbRating === 'number' ? [{ label: 'TMDB', value: d.tmdbRating.toFixed(1) }] : []),
    ],
  }),
  async run(ctx) {
    ctx.output('digest').write(await runNotify(ctx, { gapsFile: ctx.input('gaps').path }));
  },
});
