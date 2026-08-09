import type { JobDefinition } from '../../../core/types.js';
import { runScan, JOB_NAME } from './scan.js';

const job: JobDefinition = {
  name: JOB_NAME,
  description:
    'Scans the Plex movie and TV library sections LIVE (explicitly opting out of the 3-hour Plex ' +
    'response cache, since a guard must never diff a stale listing), builds a full per-file ' +
    'inventory (one entry per media Part: every movie file and every episode file with its title, ' +
    'on-disk path, and size in bytes), and diffs it against the previous run\'s persisted snapshot. ' +
    'It sends ONE urgent ntfy push if the total library size decreased beyond PLEX_GUARD_DROP_GB ' +
    '(default 0, meaning any decrease at all) or if any previously-seen file is missing, naming up ' +
    'to 20 missing titles in the push (the full list always lands in guard-report.json and the run ' +
    'log). The baseline snapshot is only overwritten AFTER the alert path settles: a failed push ' +
    'throws before the snapshot write, so a retry re-diffs against the intact baseline and ' +
    're-attempts, with an already-alerted ledger (keyed by the previous snapshot\'s timestamp) ' +
    'preventing a duplicate push on that path. Two bad-read guards protect the baseline: an empty ' +
    'movie or episode listing throws before any write, and a suspected partial read (more than ' +
    'half the previous inventory missing at once) still alerts loudly but preserves the baseline ' +
    'and fails the run, so a transient Plex misread self-heals next run. First run seeds the ' +
    'baseline and sends nothing. Safe to re-run any time: one ledger row per calendar day.',
  timeoutMs: 300_000,
  maxRetries: 3,
  async run(ctx) {
    await runScan(ctx);
  },
};

export default job;
