import type { JobDefinition } from '../../../core/types.js';
import { resolveInputKeys, runBuild } from './build.js';

const job: JobDefinition = {
  name: 'plex-profiles-build',
  description:
    'Scans the owner\'s entire Plex library (movies AND TV shows) and writes one markdown profile ' +
    'file per title to data/out/movies/ or data/out/shows/, sourced purely from data the Plex API ' +
    'already exposes (list endpoints for the section contents plus a per-title GET ' +
    '/library/metadata/<ratingKey> detail fetch) — no LLM call anywhere in this stage. Each movie\'s ' +
    'profile covers its own file size/resolution/codec; each TV show\'s profile sums every episode\'s ' +
    'media parts across every season for a total library size, since a show carries no size of its ' +
    'own. It is idempotent per title via the work_items ledger\'s stored updatedAt marker — a title ' +
    'whose Plex updatedAt has not moved since its last successful build is skipped, mirroring ' +
    'projects-sync\'s pushedAt-marker idiom, so re-runs only rebuild what actually changed. It ' +
    'declares inputKeys() (every movie:<ratingKey> / show:<ratingKey> in the library) so a manual run ' +
    'can be limited, and PLEX_PROFILES_RUN_LIMIT caps how many titles are (re)built in a single run so ' +
    'a large first-run backlog does not blow the timeout — the next run resumes with whatever is left.',
  timeoutMs: 1_800_000,
  maxRetries: 3,
  inputKeys: resolveInputKeys,
  async run(ctx) {
    await runBuild(ctx);
  },
};

export default job;
