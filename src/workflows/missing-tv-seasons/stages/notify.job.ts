import type { JobDefinition } from '../../../core/types.js';
import { missingSeasonsContract } from '../contracts.js';
import { runNotify } from './notify.js';

const job: JobDefinition = {
  name: 'plex-seasons-notify',
  description: 'Stage 3 of the weekly missing-TV-seasons audit, and the ONLY stage where idempotency is enforced. It reads the missing-seasons list from stage 2 and checks each (show, season) pair against a work_items ledger keyed by "<tmdbId>::S<season>" under this job\'s name — but that ledger is a notification log, not a work-done log: a row records whether that exact pair has already been announced before, not whether the underlying work is complete, so an "up to date" show never gets a row at all. Any pair not yet marked notified is newly-detected; the stage bundles all of them into a single push notification (rather than one push per season), then marks each as notified so it is never announced again, and also writes a human-readable markdown report to data/out/reports/missing-seasons.md. On a brand-new install with an empty ledger, the very first run announces the entire current backlog of missing seasons in one digest. The owner can permanently silence a specific factual-but-unwanted gap without waiting for it to stop reappearing, via the ignore-to-suppress mechanism exposed on this workflow\'s dashboard page.',
  timeoutMs: 120_000,
  maxRetries: 3,
  consumes: [missingSeasonsContract()],
  async run(ctx) {
    await runNotify(ctx);
  },
};

export default job;
