import type { WorkflowDefinition } from '../../core/types.js';

/**
 * Daily safeguard against silent Plex library data loss: a full per-file
 * snapshot diffed run-over-run, alerting on any total-size decrease and on any
 * previously-seen file going missing. Built as a safety net while file-moving
 * workflows are developed. Supersedes plex-space-saver's old weekly shrink
 * alert (T519), which it replaces with a daily, per-file, zero-threshold check.
 *
 * Single stage, no DAG edge (so no gate contracts), no inputKeys() (audit
 * style: inputs are discovered live each run, not limitable).
 */
const workflow: WorkflowDefinition = {
  name: 'plex-library-guard',
  description:
    'Daily Plex library safeguard: snapshots every media file (title, path, size) and alerts with ' +
    'one urgent push if the total library size decreases or any previously-seen file disappears.',
  category: 'regular-maintenance',
  // Daily 10:30, staggered clear of the other Plex workflows (Sun 04:00/06:00,
  // Sat 05:00, Mon 09:00) and the other daily jobs (07:00-08:00, 23:00).
  schedule: '30 10 * * *',
  idempotencyNote:
    'Re-scans the whole library fresh every run and keeps one ledger row per calendar day, so a ' +
    'same-day re-run re-diffs against the latest baseline and updates that day\'s row in place. ' +
    'Each alert fires at most once per baseline via the already-alerted ledger; the baseline is ' +
    'only advanced after the alert path settles, so a failed run re-alerts on retry.',
  jobs: [{ job: 'plex-library-guard-scan' }],
};

export default workflow;
