import { defineStage } from '../../../engine/index.js';
import { missingMoviesConfig } from '../config.js';
import { franchiseGaps, plexMovieSnapshot } from '../contracts.js';
import { runFranchiseGaps } from './franchise-gaps.js';

export default defineStage({
  name: 'franchise-gaps',
  description: 'Stage 2: detect franchise gaps via the TMDB Collections API — released franchise films you don\'t own (no quality filter).',
  timeoutMs: 1_800_000, // ~30 min headroom: ~1,500 /movie calls + collection fetches
  maxRetries: 3,
  inputs: { snapshot: { artifact: plexMovieSnapshot } },
  outputs: {
    gaps: { artifact: franchiseGaps, location: () => missingMoviesConfig.gapsOut },
  },
  async run(ctx) {
    await runFranchiseGaps(ctx, { snapshotFile: ctx.input('snapshot').path, gapsFile: ctx.output('gaps').path });
  },
});
