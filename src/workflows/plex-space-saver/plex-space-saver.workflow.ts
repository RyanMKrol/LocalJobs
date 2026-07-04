import type { WorkflowDefinition } from '../../core/types.js';

/**
 * Plex "space saver" — a single-stage, report-only audit of where library disk
 * space is going. Scans the Plex movie + TV sections via the API (Media.Part
 * `size` bytes — no filesystem walk) and writes a biggest-first size breakdown:
 * ONE row per movie, ONE row per TV show (summing every episode across every
 * season). No deletion suggestions — this is a report, not an audit-and-flag
 * workflow like `missing-tv-seasons`. RE-SCANS FRESH every run; idempotent per
 * ISO calendar week via the work_items ledger (a manual re-run the same week
 * regenerates that week's breakdown rather than duplicating it). Runs weekly.
 * One stage, so no DAG edge — no gate needed (see src/workflows/CLAUDE.md).
 */
const workflow: WorkflowDefinition = {
  name: 'plex-space-saver',
  category: 'regular-maintenance',
  description: 'Scans your Plex movie + TV libraries via the API and reports a biggest-first disk-size breakdown (one row per movie, one row per TV show summing all episodes) — report only, never suggests deletions. Weekly.',
  schedule: '0 6 * * 0',
  jobs: [{ job: 'plex-space-saver-scan' }],
};

export default workflow;
