import { defineStage } from '../../../engine/index.js';
import { plexConfig } from '../config.js';
import { missingSeasons, plexTvSnapshot } from '../contracts.js';
import { runSeasonCheck } from './season-check.js';

export default defineStage({
  name: 'tmdb-season-check',
  description: 'Stage 2 of the weekly missing-TV-seasons audit. Reads the Plex snapshot from stage 1 and, for every show with a resolved TMDB id, calls TMDB through the shared rate-limited tmdb service to find the highest season that has actually aired and to check, season by season above what is currently owned, whether every episode in that season has aired (a genuinely complete season, not just a season that has started). Shows marked ended or canceled on TMDB are still checked, not skipped, since a cancelled show can be revived with new seasons later. Like stage 1, this stage recomputes fresh on every run rather than skipping already-checked shows, and writes no ledger rows, because the only thing this workflow remembers between runs is what the final notify stage has announced. Every show with a complete season the owner is missing is written to data/out/missing-seasons.json for stage 3, along with the shows that could not be checked: those with no tmdb:// GUID and those whose TMDB call failed. If there are any such shows the stage fails the run, but only after that file is written and committed as its output, so the failed run still shows which shows were the problem. A TMDB quota stop ends the loop early without failing.',
  timeoutMs: 1_800_000, // ~30 min headroom for a full-library scan (~621 shows)
  maxRetries: 3,
  inputs: { snapshot: { artifact: plexTvSnapshot } },
  outputs: {
    missing: { artifact: missingSeasons, location: () => plexConfig.missingOut },
  },
  async run(ctx) {
    const missing = ctx.output('missing');
    try {
      await runSeasonCheck(ctx, { snapshotFile: ctx.input('snapshot').path, missingFile: missing.path });
    } catch (err) {
      // The check writes what it found before it fails for a show it could not
      // check. Commit that, so the failed run's page lists those shows; then fail.
      try { missing.commit(); } catch { /* nothing was written: the original error is the story */ }
      throw err;
    }
  },
});
