import type { JobContext } from '../../../core/types.js';
import { isWorkItemDone, markWorkItem } from '../../../db/store.js';
import { plexRenameConfig } from '../config.js';
import { fetchItemDetail } from '../lib.js';
import type { ApplyDetail, ConfirmDetail } from '../types.js';
import { ledgerSuccessRows } from './ledger.js';

export const JOB_NAME = 'plex-rename-confirm';
export const APPLY_JOB = 'plex-rename-apply';
const MAX_ATTEMPTS = 3;

export interface ConfirmOverrides {
  fetchItemDetail?: typeof fetchItemDetail;
  readApplyRows?: () => { itemKey: string; detail: unknown }[];
  graceDays?: number;
  now?: () => Date;
}

function parseKey(itemKey: string): { ratingKey: string; partId: number } {
  const idx = itemKey.lastIndexOf('::part');
  return { ratingKey: itemKey.slice(0, idx), partId: Number(itemKey.slice(idx + 6)) };
}

/**
 * Post-rename verification that PLEX ITSELF re-associated each moved file at
 * the SAME ratingKey (watch state, collections, and metadata intact). For each
 * applied-but-not-yet-confirmed item, a LIVE metadata fetch:
 *  - same ratingKey now reports the new path → confirmed (once-ever success);
 *  - still the old path → Plex just hasn't rescanned: recorded 'skipped'
 *    (retryable) and re-checked next run, until the grace window
 *    (PLEX_RENAME_CONFIRM_GRACE_DAYS) expires — then it fails LOUD;
 *  - the ratingKey no longer resolves → the worst failure mode (Plex may have
 *    spawned a DUPLICATE item under a new ratingKey, orphaning watch state):
 *    fails loud immediately. plex-library-guard independently screams about
 *    the vanished key too — two detectors, by design.
 */
export async function runConfirm(ctx: JobContext, opts: ConfirmOverrides = {}): Promise<void> {
  const doFetch = opts.fetchItemDetail ?? fetchItemDetail;
  const readApplyRows = opts.readApplyRows ?? (() => ledgerSuccessRows(APPLY_JOB));
  const graceDays = opts.graceDays ?? plexRenameConfig.confirmGraceDays;
  const now = opts.now ?? (() => new Date());

  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log(`plex-rename-confirm starting — live re-association check (grace window ${graceDays} day(s)).`);

  const pending = readApplyRows().filter((r) => ctx.rootAllowed(r.itemKey) && !isWorkItemDone(JOB_NAME, r.itemKey, MAX_ATTEMPTS));
  ctx.log(`Applied items awaiting confirmation: ${pending.length}`);
  ctx.progress(5, `${pending.length} to confirm`);

  let confirmed = 0;
  let stillPending = 0;
  let failed = 0;

  for (let i = 0; i < pending.length; i++) {
    const row = pending[i];
    const apply = row.detail as ApplyDetail;
    const { ratingKey, partId } = parseKey(row.itemKey);
    const record = (detail: ConfirmDetail, status: 'success' | 'failed' | 'skipped') => {
      markWorkItem(JOB_NAME, row.itemKey, status, { detail });
    };

    let item;
    try {
      item = await doFetch(ratingKey);
    } catch (err) {
      stillPending++;
      ctx.log(`  ⚠ "${apply.name}" — Plex fetch failed (${err instanceof Error ? err.message : err}); re-checked next run`, 'warn');
      record({ name: apply.name, confirmed: false, reason: 'pending-rescan', reasonDetail: 'plex fetch failed (transient?)' }, 'skipped');
      continue;
    }

    if (!item) {
      failed++;
      ctx.log(`  ✗ "${apply.name}" — ratingKey ${ratingKey} NO LONGER RESOLVES. Plex may have re-associated the renamed file under a NEW item (watch state orphaned). Investigate; plex-library-guard should have alerted too.`, 'error');
      record(
        { name: apply.name, confirmed: false, reason: 'ratingkey-gone', reasonDetail: `ratingKey ${ratingKey} not found after rename to ${apply.to}` },
        'failed',
      );
      continue;
    }

    const parts = (item.Media ?? []).flatMap((m) => m.Part ?? []);
    const part = parts.find((p) => p.id === partId) ?? parts[0];
    const currentPath = part?.file?.normalize('NFC');
    if (currentPath === apply.to.normalize('NFC')) {
      confirmed++;
      ctx.log(`  ✓ "${apply.name}" — Plex reports the new path at the same ratingKey ${ratingKey} (watch state/metadata intact)`);
      ctx.log(`      confirmed at: ${apply.to}`);
      record({ name: `${apply.name} — confirmed`, confirmed: true, confirmedPath: apply.to }, 'success');
      continue;
    }

    const ageMs = now().getTime() - new Date(apply.appliedAt || 0).getTime();
    const graceMs = graceDays * 24 * 60 * 60 * 1000;
    if (ageMs > graceMs) {
      failed++;
      ctx.log(`  ✗ "${apply.name}" — Plex STILL reports ${currentPath ?? 'no path'} ${Math.round(ageMs / 86_400_000)}d after the rename (grace ${graceDays}d). The rescan never landed — investigate.`, 'error');
      record(
        { name: apply.name, confirmed: false, reason: 'grace-exceeded', reasonDetail: `still ${currentPath ?? 'unknown'} after ${Math.round(ageMs / 86_400_000)}d` },
        'failed',
      );
    } else {
      stillPending++;
      ctx.log(`  · "${apply.name}" — Plex hasn't picked up the new path yet (${currentPath ?? 'unknown'}); re-checked next run`);
      record({ name: apply.name, confirmed: false, reason: 'pending-rescan', reasonDetail: `still ${currentPath ?? 'unknown'}` }, 'skipped');
    }
    if ((i + 1) % 25 === 0) ctx.progress(5 + Math.round((90 * (i + 1)) / pending.length), `${i + 1}/${pending.length} checked`);
  }

  ctx.log('═══════════════ CONFIRM SUMMARY ═══════════════');
  ctx.log(`Confirmed: ${confirmed} · still pending rescan: ${stillPending} · failed: ${failed}`);
  ctx.log('═════════════════════════════════════════════');
  ctx.progress(100, `${confirmed} confirmed, ${stillPending} pending, ${failed} failed`);
  if (failed > 0) {
    throw new Error(`${failed} renamed item(s) failed confirmation — see logs above`);
  }
}
