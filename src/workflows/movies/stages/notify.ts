// Movie-domain thin wrapper over the shared recommender notify stage
// (src/core/recommender/notify.ts, T561). Keeps the exact same exported API
// (`runNotify`, `buildDigest`, `NotifyOpts`, `PushFn`) so `notify.job.ts` and
// every existing notify test keeps working unchanged.
import { push } from '../../../core/notifier.js';
import type { JobContext } from '../../../core/types.js';
import { runRecsNotify } from '../../../core/recommender/notify.js';
import type { NotifyRunOpts } from '../../../core/recommender/notify.js';
import { ensureDirs } from '../lib.js';
import { buildDigest, moviesDomain } from './branches.js';

/**
 * COMPAT SHIM (T468): the franchise-gap "already-notified" ledger constant + key
 * function moved with the franchise-gap audit to the separate `missing-movies`
 * workflow (its OWN `movie-gaps-notify` job, unchanged job name/ledger key — no
 * migration needed). `src/api/server.ts` (out of this task's scope) still imports
 * `NOTIFY_JOB`/`gapKey` from this file's path — re-exporting keeps that resolving
 * without touching it. T469 (already queued) finishes the relocation.
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
