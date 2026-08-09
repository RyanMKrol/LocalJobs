import type { WorkflowDefinition } from '../../core/types.js';

/**
 * media-reviews — pulls the owner's book/movie/TV/album review data from the
 * website's four DynamoDB tables (the live stores behind
 * ryankrol.co.uk/reviews/*) and writes one markdown file per review to
 * data/out/<category>/, ready for vault-sync to mirror into the second-brain
 * vault (Reviews/Books|Movies|TV|Albums). Strictly read-only against Dynamo —
 * the same shared `dynamodb` service + AWS credentials the perfumes workflow
 * already uses for PerfumeRatings; the site is never scraped.
 *
 * Four INDEPENDENT single-stage jobs, one per category — no dependsOn edges,
 * so no gates are needed (plex-profiles precedent) and the default
 * maxConcurrency (4) runs them all in parallel. Deliberately NO inputKeys()
 * on any member: with four independent members, a run-limit's root selection
 * would bind to whichever job sorts first and ctx.rootAllowed would silently
 * filter the other three categories to nothing — see this folder's CLAUDE.md.
 *
 * Daily at 04:00 — before vault-sync's 07:30 so a new review reaches the
 * vault the same morning, and 24h apart so the dynamodb service's 22h
 * response cache never serves a scheduled run a stale scan.
 */
const workflow: WorkflowDefinition = {
  name: 'media-reviews',
  category: 'second-brain',
  description:
    'Pulls the owner\'s book, movie, TV, and album reviews from the website\'s DynamoDB tables '
    + '(read-only scans — never scraping the site) and writes one markdown file per review, with the '
    + 'review text verbatim plus whatever metadata the site recorded. Four independent jobs, one per '
    + 'category, running in parallel. Daily, ahead of vault-sync\'s morning mirror.',
  idempotencyNote:
    'Each review is tracked by a content hash of its raw DynamoDB item: an unchanged review is skipped '
    + 'entirely on re-run, and an added or edited review (including silent metadata backfills that do not '
    + 'stamp editedDate) is (re)written. Safe to run any time — a steady-state run scans the four tables '
    + 'and writes nothing.',
  schedule: '0 4 * * *',
  jobs: [
    { job: 'media-reviews-books' },
    { job: 'media-reviews-movies' },
    { job: 'media-reviews-tv' },
    { job: 'media-reviews-albums' },
  ],
};

export default workflow;
