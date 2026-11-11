import { push as realPush } from '../../../core/notifier.js';
import { isWorkItemDone, markWorkItem } from '../../../db/store.js';
import type { JobContext } from '../../../engine/index.js';
import type { AlertDigest } from '../contracts.js';
import type { BackupReport } from '../types.js';

export const ALERT_JOB = 'plex-posters-alert';

/** A push function shaped like core/notifier `push` (injectable for tests). */
export type PushFn = (title: string, body: string, opts?: { priority?: string; tags?: string; job?: string }) => Promise<{ ok: boolean; error?: string }>;

/**
 * Send ONE push when a large share of posters changed since the previous
 * snapshot. A handful changing in a week is normal (new artwork picked, a title
 * re-matched). A large share changing at once usually means a metadata refresh
 * has replaced the owner's chosen posters, which is the event this backup exists
 * for, and the sooner it is noticed the fewer good snapshots it sits behind.
 *
 * The ledger here is a "have I already alerted about this snapshot?" record, keyed
 * by the snapshot's timestamp, so a retry of this stage cannot send the push twice.
 */
export async function runAlert(
  ctx: JobContext,
  report: BackupReport,
  opts: { thresholdPct: number; minChanged: number; push?: PushFn },
): Promise<AlertDigest> {
  const push = opts.push ?? realPush;
  const base = { changed: report.changed, changedPct: report.changedPct };
  ctx.log(`plex-posters-alert starting: ${report.changed} of ${report.compared} poster(s) changed (${report.changedPct}%); alerting at ${opts.thresholdPct}% and at least ${opts.minChanged}`);

  if (!report.previousSnapshot) {
    ctx.log('First snapshot: nothing to compare, no alert');
    return { alerted: false, ...base, reason: 'the first snapshot has nothing to be compared with' };
  }
  if (report.changed < opts.minChanged || report.changedPct < opts.thresholdPct) {
    ctx.log('Below the threshold: no alert');
    return { alerted: false, ...base, reason: `${report.changed} changed (${report.changedPct}%), below the threshold of ${opts.thresholdPct}% and ${opts.minChanged}` };
  }
  const reason = `${report.changed} of ${report.compared} posters (${report.changedPct}%) changed since ${report.previousSnapshot.slice(0, 10)}`;
  if (isWorkItemDone(ALERT_JOB, report.createdAt, 1)) {
    ctx.log(`Already alerted about the snapshot of ${report.createdAt}: not sending again`);
    return { alerted: true, ...base, reason: `${reason} (already announced)` };
  }

  const sample = report.changes.slice(0, 8).map((c) => c.label).join(', ');
  const body =
    `${reason}. If you did not change them yourself, a metadata refresh may have replaced your posters. ` +
    `The previous snapshot still has the old ones: restore with scripts/plex-posters-restore.ts.` +
    (sample ? `\nFor example: ${sample}${report.changed > 8 ? ', ...' : ''}` : '');
  const sent = await push('Plex posters: a large share changed', body, { priority: 'high', tags: 'warning,frame_with_picture', job: ALERT_JOB });
  if (!sent.ok) throw new Error(`the alert could not be sent: ${sent.error ?? 'unknown error'}`);
  markWorkItem(ALERT_JOB, report.createdAt, 'success', { detail: { name: `Alert: ${reason}`, changed: report.changed, changedPct: report.changedPct } });
  ctx.log(`Alert sent: ${reason}`, 'warn');
  return { alerted: true, ...base, reason };
}
