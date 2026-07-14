// TV-domain thin wrapper over the shared recommender notify stage
// (src/core/recommender/notify.ts, T561). Keeps the exact same exported API
// (`runTvRecsNotify`, `buildDigest`, `NotifyOpts`) so `tv-recs-notify.job.ts`
// and every existing notify test keeps working unchanged.
import { push } from '../../../core/notifier.js';
import type { JobContext } from '../../../core/types.js';
import { runRecsNotify } from '../../../core/recommender/notify.js';
import type { NotifyRunOpts } from '../../../core/recommender/notify.js';
import { ensureDirs } from '../lib.js';
import { buildDigest, tvDomain } from './branches.js';

export { buildDigest };

/** A push function shaped like core/notifier `push` (injectable for tests). */
export type PushFn = typeof push;

export interface NotifyOpts {
  push?: PushFn;
  now?: Date;
  recsFile?: string;
  historyFile?: string;
  reportDir?: string;
}

/**
 * Stage: monthly TV recommendations digest. Reads the verified recommendations.json
 * from tv-rec-merge, drops owner-ignored and already-notified shows, sends ONE digest
 * of just the new picks, marks each notified show success in the tv-recs ledger (so
 * it's never re-notified), and writes a markdown report under data/out/reports/. See
 * src/core/recommender/notify.ts for the full behaviour.
 */
export async function runTvRecsNotify(ctx: JobContext, opts: NotifyOpts = {}): Promise<void> {
  ensureDirs();
  await runRecsNotify(ctx, tvDomain, opts as NotifyRunOpts);
}
