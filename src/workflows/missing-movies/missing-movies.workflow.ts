import type { WorkflowDefinition } from '../../core/types.js';

/**
 * The Plex movie franchise-gap audit as a first-class DAG the framework
 * executes (T468 — split out of `movie-recommendations`, which used to bundle
 * this deterministic audit together with the subjective recommendation layer
 * in one combined monthly digest; see `src/workflows/movies/CLAUDE.md` and
 * `.harness/worklog/T467.md` for the split's design record):
 *   plex-movie-snapshot → franchise-gaps → movie-gaps-notify
 *
 * Scheduled WEEKLY (Mondays 09:00) — matching `missing-tv-seasons`'s cadence, a
 * DELIBERATE cadence CHANGE from the monthly cadence this audit ran at while it
 * shared `movie-recommendations`'s digest. This workflow INVERTS the usual
 * pattern, exactly like `missing-tv-seasons`:
 *  - NO member declares `inputKeys()`, so the workflow is NOT limitable — its
 *    inputs are DISCOVERED live from Plex each run, not a static file. Scheduled
 *    + always unlimited.
 *  - `plex-movie-snapshot` + `franchise-gaps` RE-COMPUTE FRESH every run (no
 *    skip-if-done). Only the final notify stage uses the `work_items` ledger —
 *    and there it's a "have I already notified this gap?" / "has the owner
 *    ignored it?" log, NOT a work-done ledger — so a backlog gap is announced
 *    exactly once and an owner-ignored gap is suppressed forever.
 *
 * `plex-movie-snapshot` is a DELIBERATE duplicate of `movie-recommendations`'s
 * `movie-snapshot` job (own job, own `data/out/`, T467 design decision) rather
 * than a shared stage, mirroring `missing-tv-seasons`'s `plex-tv-snapshot` vs
 * `tv-recommendations`'s `tv-snapshot`. It skips building a taste profile since
 * `franchise-gaps` never reads one.
 *
 * The `franchise-gaps` and `movie-gaps-notify` job NAMES, and the
 * `movie-gaps-notify` ledger key, are UNCHANGED from before the split — no
 * work_items migration was needed or performed.
 *
 * Serial (maxConcurrency 1, the default): each stage strictly feeds the next.
 */
const workflow: WorkflowDefinition = {
  name: 'missing-movies',
  category: 'recommendations',
  description: 'Audits your Plex movie library for FRANCHISE GAPS — films you own some-but-not-all of in a collection, via the TMDB Collections API. No quality filter: every factual gap is surfaced. Pushes ONE weekly digest of the newly-detected gaps. Deduped per tmdb id via the work-item ledger so each backlog gap is announced exactly once; the first run is one big digest of the whole current backlog; the owner can ignore-to-suppress a gap. Split out of movie-recommendations (T468), which now covers taste-based recommendations only.',
  schedule: '0 9 * * 1',
  jobs: [
    { job: 'plex-movie-snapshot' },
    { job: 'franchise-gaps', dependsOn: ['plex-movie-snapshot'] },
    { job: 'movie-gaps-notify', dependsOn: ['franchise-gaps'] },
  ],
};

export default workflow;
