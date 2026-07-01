import type { WorkflowDefinition } from '../../core/types.js';

/**
 * The Plex new-seasons audit as a first-class DAG the framework executes:
 *   plex-tv-snapshot → tmdb-season-check → plex-seasons-notify
 *
 * Scheduled weekly (Mondays 09:00). This workflow INVERTS the usual pattern:
 *  - NO member declares `inputKeys()`, so the workflow is NOT limitable — its
 *    inputs are DISCOVERED live from Plex each run, not a static file. Scheduled
 *    + always unlimited.
 *  - Snapshot + season-check RE-SCAN FRESH every run (no skip-if-done). Only the
 *    final notify stage uses the `work_items` ledger — and there it's a "have I
 *    already notified this (show, season)?" log, NOT a work-done ledger — so a
 *    backlog season is announced exactly once.
 * Serial (maxConcurrency 1): each stage strictly feeds the next.
 */
const workflow: WorkflowDefinition = {
  name: 'missing-tv-seasons',
  category: 'recommendations',
  description: 'Audits your Plex TV library for newly-released COMPLETE seasons you don\'t own. It snapshots section 5 by GUID (each show + its highest owned regular season), checks TMDB by tmdb:// id for the highest aired regular season and which missing seasons are fully aired (ended/canceled shows included — revivals happen), then pushes ONE weekly digest of the newly-detected missing seasons. Deduped per (show, season) via the work-item ledger so each backlog season is announced exactly once; the first run is one big digest of the whole current backlog.',
  schedule: '0 9 * * 1',
  maxConcurrency: 1,
  jobs: [
    { job: 'plex-tv-snapshot' },
    { job: 'tmdb-season-check', dependsOn: ['plex-tv-snapshot'] },
    { job: 'plex-seasons-notify', dependsOn: ['tmdb-season-check'] },
  ],
};

export default workflow;
