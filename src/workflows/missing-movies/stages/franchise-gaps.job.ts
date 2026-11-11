import { defineStage } from '../../../engine/index.js';
import { missingMoviesConfig } from '../config.js';
import { franchiseGaps, plexMovieSnapshot } from '../contracts.js';
import { runFranchiseGaps } from './franchise-gaps.js';

export default defineStage({
  name: 'franchise-gaps',
  description: 'Second stage of the weekly missing-movies audit. It reads the Plex movie snapshot from plex-movie-snapshot and works in two passes against TMDB, both through the shared rate-limited tmdb service. First it looks up every owned movie that has a TMDB id to find which collection it belongs to, collecting each distinct collection once. Then it fetches each collection and lists every released film in it that the owner does not have. There is no quality filter: every gap is listed, and the TMDB rating is kept for context only. It recomputes everything on every run and writes no ledger rows. The result goes to franchise-gaps.json, sorted by collection, with one owned title per collection for the report to show. A collection that could not be fetched is logged and the rest carry on, but the stage then fails the run after writing the file so it is retried. A TMDB quota stop ends the pass early and writes what was found so far.',
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
