import type { WorkflowDefinition } from '../../core/types.js';

/**
 * plex-profiles — a single-stage build that writes one markdown profile per
 * Plex title (movie + TV show), sourced purely from the Plex API (list +
 * per-title detail endpoints). No LLM is involved (phase 1 only; see this
 * folder's CLAUDE.md for the deferred phase 2). Distinct from the other
 * Plex-touching workflows: none of them cover BOTH movies and shows with a
 * per-title markdown output (missing-tv-seasons audits season completeness,
 * movie-recommendations/tv-recommendations build recommendation digests,
 * missing-movies reports franchise gaps, plex-space-saver reports a disk-size
 * breakdown only).
 *
 * Idempotent per title via the work_items ledger's stored `updatedAt` marker
 * (a title unchanged since its last build is skipped). One stage, so no DAG
 * edge. Its two declared outputs are the movie and show profile folders, both
 * cumulative. Runs weekly, offset from plex-space-saver's Sunday 06:00 slot.
 */
const workflow: WorkflowDefinition = {
  name: 'plex-profiles',
  category: 'second-brain',
  description: 'Scans your entire Plex library (movies + TV shows) and writes one markdown profile per title, sourced purely from Plex API data (cast, ratings, technical detail, file size) — no LLM. Weekly.',
  idempotencyNote: 'Each movie and show is tracked individually and only rebuilt when Plex\'s own "last updated" marker for that title has changed since its last successful build — an unchanged title is skipped entirely, so re-runs are cheap and only touch what\'s actually changed.',
  schedule: '0 5 * * 6',
  jobs: [{ job: 'plex-profiles-build' }],
};

export default workflow;
