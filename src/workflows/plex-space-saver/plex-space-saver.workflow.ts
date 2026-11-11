import type { WorkflowDefinition } from '../../core/types.js';

/**
 * Plex "space saver" — a single-stage, report-only audit of where library disk
 * space is going. Scans the Plex movie + TV sections via the API (Media.Part
 * `size` bytes — no filesystem walk) and writes a biggest-first size breakdown:
 * ONE row per movie, ONE row per TV show (summing every episode across every
 * season). No deletion suggestions: this is a report, not an audit-and-flag
 * workflow like `missing-tv-seasons`. It re-scans fresh every run and rewrites
 * its one declared output, the breakdown file, in place. There is no ledger, so
 * a re-run simply replaces the file. Runs weekly. One stage, so no DAG edge.
 */
const workflow: WorkflowDefinition = {
  name: 'plex-space-saver',
  category: 'regular-maintenance',
  description: 'Scans your Plex movie + TV libraries via the API and reports a biggest-first disk-size breakdown (one row per movie, one row per TV show summing all episodes) — report only, never suggests deletions. Weekly.',
  idempotencyNote: 'This workflow re-scans your whole Plex library fresh every run (nothing is skipped) and rewrites the one size-breakdown report in place, so re-running it just replaces the report with a newer one.',
  schedule: '0 6 * * 0',
  jobs: [{ job: 'plex-space-saver-scan' }],
};

export default workflow;
