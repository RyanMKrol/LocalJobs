import type { WorkflowDefinition } from '../../core/types.js';

/**
 * The Plex movie franchise-gap audit as its OWN first-class DAG the framework
 * executes, split out of `movie-recommendations` (T468) so the deterministic gap
 * audit and the subjective recommendation layer run and notify independently —
 * mirroring the existing `tv-recommendations` / `missing-tv-seasons` split:
 *   plex-movie-snapshot → franchise-gaps → movie-gaps-notify
 *
 * Scheduled WEEKLY (Mondays 09:00), matching `missing-tv-seasons` exactly — a
 * deliberate cadence change from the old monthly cadence inside the combined
 * workflow, for more frequent gap alerts. This workflow INVERTS the usual
 * pattern, exactly like the TV `missing-tv-seasons` workflow:
 *  - NO member declares `inputKeys()`, so the workflow is NOT limitable — its
 *    inputs are DISCOVERED live from Plex each run, not a static file. Scheduled
 *    + always unlimited.
 *  - Snapshot + franchise-gaps RE-COMPUTE FRESH every run (no skip-if-done). Only
 *    the final notify stage uses the `work_items` ledger — and there it's a "have
 *    I already notified this gap?" / "has the owner ignored it?" log, NOT a
 *    work-done ledger — so a backlog gap is announced exactly once and an
 *    owner-ignored gap is suppressed forever.
 *
 * The `franchise-gaps` job name and `movie-gaps-notify` job name/ledger key are
 * UNCHANGED from before the split, so no work_items migration is needed.
 */
const workflow: WorkflowDefinition = {
  name: 'missing-movies',
  category: 'recommendations',
  description: 'Audits your Plex movie library for FRANCHISE GAPS — films you own some-but-not-all of in a collection, via the TMDB Collections API. No quality filter — every factual gap is surfaced. Its own Plex snapshot (separate from movie-recommendations), a deterministic collection-gap detector, and a weekly digest of newly-detected gaps grouped by collection. The owner can ignore-to-suppress a gap from the dashboard.',
  schedule: '0 9 * * 1',
  maxConcurrency: 1,
  jobs: [
    { job: 'plex-movie-snapshot' },
    { job: 'franchise-gaps', dependsOn: ['plex-movie-snapshot'] },
    { job: 'movie-gaps-notify', dependsOn: ['franchise-gaps'] },
  ],
};

export default workflow;
