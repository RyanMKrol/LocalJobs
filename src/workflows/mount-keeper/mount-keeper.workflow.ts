import type { WorkflowDefinition } from '../../core/types.js';

/**
 * Keeps the NAS SMB shares mounted on this Mac. macOS network mounts are
 * lazy (Finder-click to mount) and don't survive reboots — but plex-rename
 * (and anything else touching the NAS through /Volumes) needs them reliably
 * present. Hourly at :45, so the 04:45 check guarantees fresh mounts right
 * before plex-rename's 05:00 daily run. Modeled as a workflow (rather than a
 * separate launchd agent) so it can be toggled, monitored, and run on demand
 * from the dashboard like everything else.
 */
const workflow: WorkflowDefinition = {
  name: 'mount-keeper',
  category: 'regular-maintenance',
  description:
    'Keeps the configured NAS SMB shares mounted at /Volumes/<name>: hourly health check (exists + ' +
    'non-empty), stale empty mountpoint dirs removed (so a remount can never silently divert to ' +
    '"<name> - 1"), and missing shares remounted via Keychain-authenticated "mount volume" — the ' +
    'availability guarantee plex-rename\'s daily 05:00 run depends on. Fails loud when a share cannot ' +
    'be brought up.',
  idempotencyNote:
    'Every run re-checks all configured shares fresh and re-records one snapshot ledger row per share ' +
    '(keyed by mount point) — an already-healthy mount is never touched, so back-to-back runs are ' +
    'harmless no-ops.',
  schedule: '45 * * * *',
  jobs: [{ job: 'mount-keeper-check' }],
};

export default workflow;
