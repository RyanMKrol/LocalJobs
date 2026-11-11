import { defineStage } from '../../../engine/index.js';
import { discoveredFiles, resolvedLanguages } from '../contracts.js';
import { runResolve } from './resolve.js';

export default defineStage({
  name: 'plex-language-resolve',
  description:
    'For every file plex-language-discover recorded that has not yet been resolved, looks up its ' +
    'show/movie\'s true original language + candidate spoken languages via TMDB, routed through the ' +
    'shared rate-limited tmdb service with its response cache keyed by tmdb id (entries last 22 hours), ' +
    'so a show with many not-yet-resolved episodes in the same run makes only ONE real TMDB call for the ' +
    'whole show, not one per episode. Every file still records its own permanent ledger row, so this stage never ' +
    're-resolves a file once it has succeeded. A hit TMDB day/month quota is caught per-file and stops the ' +
    'run gracefully; the file is left un-done and retried automatically on the next run once the quota resets.',
  timeoutMs: 3_600_000,
  maxRetries: 3,
  inputs: { files: { artifact: discoveredFiles } },
  outputs: { languages: { artifact: resolvedLanguages } },
  async run(ctx) {
    await runResolve(ctx);
  },
});
