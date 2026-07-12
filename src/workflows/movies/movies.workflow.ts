import type { WorkflowDefinition } from '../../core/types.js';

/**
 * The movie RECOMMENDATION layer as a first-class DAG the framework executes:
 *   movie-snapshot → (8 recommender branches) → rec-merge → movie-recs-notify
 *
 * Scheduled MONTHLY (1st of the month, 09:00). A fan-out of 8 Claude recommender
 * branches (3 stratified-random serendipity + 5 targeted — auteur-completion,
 * top-genre-canon, thin-genre round-out, older-era classics, world cinema), each
 * off the snapshot, merged by `rec-merge` which TMDB-verifies every suggestion
 * (real, un-owned, not previously recommended), dedupes, and balances per genre.
 * `movie-recs-notify` pushes the monthly recommendations digest.
 *
 * (The DETERMINISTIC franchise-gap audit — snapshot → franchise-gaps →
 * movie-gaps-notify — moved to the separate `missing-movies` workflow, T468,
 * mirroring how `missing-tv-seasons` and `tv-recommendations` are two
 * independent workflows for TV. `missing-movies` has its OWN dedicated Plex
 * snapshot, not this one.)
 *
 * Fan-out (maxConcurrency 4, T156): all 8 recommender branches depend ONLY on
 * movie-snapshot, so once it finishes they're all ready and run up to 4 at a
 * time instead of one-after-another. Each branch is its own child process
 * invoking the Claude CLI; capping at 4 protects the Mac Mini while still
 * collapsing the run's wall-time. Cross-process coordination is unaffected —
 * every branch routes its Claude calls through the shared `claude-cli` service
 * (`callService` → the SQLite `service_usage` meter), so the rate limit + monthly
 * quota are enforced GLOBALLY regardless of how many branches run at once; the
 * service is the spend governor, not the concurrency cap.
 *
 * **Not limitable** — no member declares `inputKeys()`. `movie-snapshot`
 * RE-COMPUTES FRESH every run (no skip-if-done); only `movie-recs-notify` uses
 * the `work_items` ledger, and there it's a "have I already recommended this
 * film?" / "has the owner ignored it?" log, NOT a work-done ledger.
 */
const workflow: WorkflowDefinition = {
  name: 'movie-recommendations',
  category: 'recommendations',
  description: 'Surfaces taste-based movie RECOMMENDATIONS from your Plex library: 8 Claude recommender branches (3 stratified-random + 5 targeted: auteur-completion, top-genre canon, thin-genre round-out, older-era classics, world cinema) over a stratified library sample, merged with code-side TMDB verification (real, un-owned, never re-recommended), cross-branch dedup, and per-genre balancing. Pushes a monthly recommendations digest. Dedupes per tmdb id so nothing repeats; the owner can ignore-to-suppress a recommendation. (The separate franchise-gap audit moved to the `missing-movies` workflow.)',
  schedule: '0 9 1 * *',
  maxConcurrency: 4,
  jobs: [
    { job: 'movie-snapshot' },
    // 8 recommender branches fan out from the snapshot…
    { job: 'rec-random-1', dependsOn: ['movie-snapshot'] },
    { job: 'rec-random-2', dependsOn: ['movie-snapshot'] },
    { job: 'rec-random-3', dependsOn: ['movie-snapshot'] },
    { job: 'rec-auteur', dependsOn: ['movie-snapshot'] },
    { job: 'rec-canon', dependsOn: ['movie-snapshot'] },
    { job: 'rec-thin-genre', dependsOn: ['movie-snapshot'] },
    { job: 'rec-older-era', dependsOn: ['movie-snapshot'] },
    { job: 'rec-world-cinema', dependsOn: ['movie-snapshot'] },
    // …and merge back in, TMDB-verified + balanced.
    {
      job: 'rec-merge',
      dependsOn: [
        'rec-random-1', 'rec-random-2', 'rec-random-3',
        'rec-auteur', 'rec-canon', 'rec-thin-genre', 'rec-older-era', 'rec-world-cinema',
      ],
    },
    { job: 'movie-recs-notify', dependsOn: ['rec-merge'] },
  ],
};

export default workflow;
