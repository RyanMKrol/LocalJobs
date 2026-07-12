import type { WorkflowDefinition } from '../../core/types.js';

/**
 * The Plex movie RECOMMENDATION layer (T146) as a first-class DAG the framework
 * executes — a fan-out of 8 Claude recommender branches (3 stratified-random
 * serendipity + 5 targeted: auteur-completion, top-genre-canon, thin-genre
 * round-out, older-era classics, world cinema), each off the shared movie
 * snapshot, merged by `rec-merge` which TMDB-verifies every suggestion (real,
 * un-owned, not previously recommended), dedupes, and balances per genre. A
 * separate `missing-movies` workflow (T468 split) owns the DETERMINISTIC
 * franchise-gap audit that used to live here, mirroring the existing
 * `tv-recommendations` / `missing-tv-seasons` split.
 *
 * Scheduled MONTHLY (1st of the month, 09:00). This workflow's own Plex snapshot
 * (`movie-snapshot`) also builds a taste profile (genres/directors/decades/
 * countries), fed to the recommender branches — `missing-movies`'s snapshot does
 * NOT, since it has no need for one.
 *
 * NO member declares `inputKeys()`, so the workflow is NOT limitable — its
 * inputs are DISCOVERED live from Plex each run, not a static file. `movie-snapshot`
 * RE-COMPUTES FRESH every run (no skip-if-done). Only the terminal notify stage
 * uses the `work_items` ledger — and there it's a "have I already recommended
 * this?" / "has the owner ignored it?" log, NOT a work-done ledger — so a
 * recommendation is surfaced exactly once and an owner-ignored one is
 * suppressed forever.
 *
 * Fan-out (maxConcurrency 4, T156): all 8 recommender branches depend ONLY on
 * movie-snapshot, so once it finishes they're all ready and run up to 4 at a
 * time instead of one-after-another. Each branch is its own child process
 * invoking the Claude CLI; capping at 4 protects the Mac Mini while still
 * collapsing the run's wall-time. Cross-process coordination is unaffected —
 * every branch routes its Claude calls through the shared `claude-cli` service
 * (`callService` → the SQLite `service_usage` meter), so the rate limit +
 * monthly quota are enforced GLOBALLY regardless of how many branches run at
 * once; the service is the spend governor, not the concurrency cap.
 */
const workflow: WorkflowDefinition = {
  name: 'movie-recommendations',
  category: 'recommendations',
  description: 'Surfaces taste-based movie RECOMMENDATIONS from your Plex library: 8 Claude recommender branches (3 stratified-random + 5 targeted: auteur-completion, top-genre-canon, thin-genre round-out, older-era classics, world cinema) over a stratified library sample, merged with code-side TMDB verification (real, un-owned, never re-recommended), cross-branch dedup, and per-genre balancing. Pushes a monthly digest of newly-recommended films. Dedupes per tmdb id so nothing repeats; the owner can ignore-to-suppress a recommendation. The deterministic franchise-gap audit that used to share this DAG now lives in the separate missing-movies workflow.',
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
