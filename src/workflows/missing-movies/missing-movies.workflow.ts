import type { WorkflowDefinition } from '../../core/types.js';

/**
 * The Plex movie franchise-gap audit as its own first-class DAG:
 *   plex-movie-snapshot → franchise-gaps → movie-gaps-notify
 *
 * Split out of `movie-recommendations` (T468) so the DETERMINISTIC franchise-gap
 * audit runs on its own weekly cadence, independent of the SUBJECTIVE monthly
 * recommendation fan-out. Mirrors `missing-tv-seasons`'s shape exactly:
 *  - NO member declares `inputKeys()`, so the workflow is NOT limitable — its
 *    inputs are DISCOVERED live from Plex each run, not a static file. Scheduled
 *    + always unlimited.
 *  - `plex-movie-snapshot` + `franchise-gaps` RE-COMPUTE FRESH every run (no
 *    skip-if-done). Only the final notify stage uses the `work_items` ledger —
 *    and there it's a "have I already notified this gap?" / "has the owner
 *    ignored it?" log, NOT a work-done ledger — so a backlog gap is announced
 *    exactly once and an owner-ignored gap is suppressed forever.
 *
 * `plex-movie-snapshot` is a DEDICATED snapshot for this workflow — deliberately
 * duplicated from `movie-recommendations`'s `movie-snapshot` rather than shared,
 * so the two workflows run on fully independent schedules with no cross-workflow
 * dependency (mirrors `plex-tv-snapshot` vs the TV recs workflow's own snapshot).
 * The `movie-gaps-notify` job name and its `work_items` ledger key
 * (`movie-gaps-notify`, keyed by tmdb id) are UNCHANGED from before the split, so
 * every already-notified/ignored gap resolves with zero data migration.
 */
const workflow: WorkflowDefinition = {
  name: 'missing-movies',
  category: 'recommendations',
  description: 'Audits your Plex movie library for FRANCHISE GAPS — films you own some-but-not-all of in a collection, via the TMDB Collections API (no quality filter; every factual gap surfaces). Pushes a weekly digest of newly-detected gaps; the owner can ignore-to-suppress a gap that\'s deliberately unwanted.',
  idempotencyNote: 'This workflow re-scans your whole Plex movie library and re-checks every collection fresh every run, and only tracks whether each detected franchise gap has already been notified or ignored — so it won\'t re-alert you about the same gap twice, but it doesn\'t skip re-checking anything.',
  schedule: '0 9 * * 1',
  jobs: [
    { job: 'plex-movie-snapshot' },
    { job: 'franchise-gaps', dependsOn: ['plex-movie-snapshot'] },
    { job: 'movie-gaps-notify', dependsOn: ['franchise-gaps'] },
  ],
};

export default workflow;
