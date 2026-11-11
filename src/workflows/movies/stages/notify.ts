// Movie-domain thin wrapper over the shared recommender notify
// (src/core/recommender/notify.ts). The stage itself (`notify.job.ts`) is built
// by `makeNotifyStage` and does not go through this file. This wrapper
// (`runNotify`, `buildDigest`, `NotifyOpts`, `PushFn`) is what the notify tests
// call. The file also carries the compat re-export below.
import { push } from '../../../core/notifier.js';
import type { JobContext } from '../../../core/types.js';
import { runRecsNotify } from '../../../core/recommender/notify.js';
import type { NotifyRunOpts } from '../../../core/recommender/notify.js';
import { ensureDirs } from '../lib.js';
import { buildDigest, moviesDomain } from './branches.js';

/**
 * COMPAT SHIM (T468): the franchise-gap "already-notified" ledger constant + key
 * function moved with the franchise-gap audit to the separate `missing-movies`
 * workflow (its own `movie-gaps-notify` job, same job name and ledger key, so no
 * migration was needed). `src/api/server.ts` still imports `NOTIFY_JOB`/`gapKey`
 * from this file's path, and this re-export keeps that resolving. It can go once
 * `server.ts` imports from `missing-movies` directly.
 */
export { NOTIFY_JOB, gapKey } from '../../missing-movies/stages/notify.js';

export { buildDigest };

/** A push function shaped like core/notifier `push` (injectable for tests). */
export type PushFn = typeof push;

export interface NotifyOpts {
  /** Override the digest push (tests). Defaults to the real `push`. */
  push?: PushFn;
  /** Override "now" (tests). Defaults to a fresh Date. */
  now?: Date;
  /** Override the recommendations file path (tests). */
  recsFile?: string;
  /** Override the recommended-history file path (tests). */
  historyFile?: string;
  /** Override the report output dir (tests). */
  reportDir?: string;
}

/**
 * Terminal stage — the monthly recommendations digest. See
 * src/core/recommender/notify.ts for the full behaviour (dedup/digest/report/
 * history + the push-ok-then-mark guard).
 */
export async function runNotify(ctx: JobContext, opts: NotifyOpts = {}): Promise<void> {
  ensureDirs();
  await runRecsNotify(ctx, moviesDomain, opts as NotifyRunOpts);
}
