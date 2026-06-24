import type { WorkflowDefinition } from '../../core/types.js';

/**
 * The Plex movie franchise-gap audit as a first-class DAG the framework executes:
 *   movie-snapshot → franchise-gaps → movie-gaps-notify
 *
 * Scheduled MONTHLY (1st of the month, 09:00). This workflow INVERTS the usual
 * pattern, exactly like the TV `plex` workflow:
 *  - NO member declares `inputKeys()`, so the workflow is NOT limitable — its
 *    inputs are DISCOVERED live from Plex each run, not a static file. Scheduled
 *    + always unlimited.
 *  - Snapshot + franchise-gaps RE-COMPUTE FRESH every run (no skip-if-done). Only
 *    the final notify stage uses the `work_items` ledger — and there it's a "have
 *    I already notified this gap?" / "has the owner ignored it?" log, NOT a
 *    work-done ledger — so a backlog gap is announced exactly once and an
 *    owner-ignored gap is suppressed forever.
 * Serial (maxConcurrency 1): each stage strictly feeds the next.
 */
const workflow: WorkflowDefinition = {
  name: 'movies',
  description: 'Audits your Plex movie library for FRANCHISE GAPS — films you own some-but-not-all of. It snapshots section 4 by GUID (each movie + its taste metadata), resolves each owned film\'s TMDB collection (belongs_to_collection), fetches every collection\'s parts, and surfaces every RELEASED franchise film whose tmdb id you don\'t own (NO quality filter, no skip heuristics — TMDB rating is context only), then pushes ONE monthly digest of the newly-detected gaps. Deduped per missing film via the work-item ledger so each gap is announced exactly once; the first run is one big digest of the whole current backlog. A gap leaves future reports + notifications only when the owner manually ignores it.',
  schedule: '0 9 1 * *',
  maxConcurrency: 1,
  jobs: [
    { job: 'movie-snapshot' },
    { job: 'franchise-gaps', dependsOn: ['movie-snapshot'] },
    { job: 'movie-gaps-notify', dependsOn: ['franchise-gaps'] },
  ],
};

export default workflow;
