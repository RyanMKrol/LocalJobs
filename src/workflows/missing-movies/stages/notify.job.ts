import { join } from 'node:path';
import { defineStage } from '../../../engine/index.js';
import { missingMoviesConfig } from '../config.js';
import { franchiseGaps, gapsDigest, gapsReport } from '../contracts.js';
import { runNotify } from './notify.js';

export default defineStage({
  name: 'movie-gaps-notify',
  description: 'Final stage of the missing-movies workflow, run once franchise-gaps succeeds. It reads franchise-gaps.json, leaves out anything the owner has dismissed from the dashboard, rewrites the markdown report (reports/franchise-gaps.md, grouped by collection) and sends one push listing the gaps that have not been announced before. Its ledger is a "have I already notified this?" log rather than a work-done ledger: each announced gap is recorded by TMDB id under this job\'s name in the work_items table, so the first run announces the entire current backlog while every later run announces only gaps newly detected since, and a dismissed gap stays out of every digest until it is un-ignored. Gaps are marked only after the push succeeds, so a failed push is retried.',
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
