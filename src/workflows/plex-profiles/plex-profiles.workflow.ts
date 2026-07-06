import type { WorkflowDefinition } from '../../core/types.js';

/**
 * plex-profiles — a single-stage build that writes one markdown profile per
 * Plex title (movie + TV show), sourced purely from the Plex API (list +
 * per-title detail endpoints) — no LLM involved (phase 1 only; see this
 * folder's CLAUDE.md for the deferred phase 2). Distinct from the other four
 * Plex-touching workflows: none of them cover BOTH movies and shows with a
 * per-title markdown output (missing-tv-seasons audits season completeness,
 * movie-recommendations/tv-recommendations do franchise-gap/recommendation
 * digests, plex-space-saver reports disk-size breakdown only).
 *
 * Idempotent per title via the work_items ledger's stored `updatedAt` marker
 * (a title unchanged since its last build is skipped). One stage, so no DAG
 * edge — no gate needed (see this folder's CLAUDE.md / src/workflows/CLAUDE.md).
 * Runs weekly, offset from plex-space-saver's Sunday 06:00 slot.
 */
const workflow: WorkflowDefinition = {
  name: 'plex-profiles',
  category: 'second-brain',
  description: 'Scans your entire Plex library (movies + TV shows) and writes one markdown profile per title, sourced purely from Plex API data (cast, ratings, technical detail, file size) — no LLM. Weekly.',
  schedule: '0 5 * * 6',
  jobs: [{ job: 'plex-profiles-build' }],
};

export default workflow;
