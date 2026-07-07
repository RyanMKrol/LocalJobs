import { writeFileSync } from 'node:fs';

import type { JobContext } from '../../../core/types.js';
import { isWorkItemDone, markWorkItem } from '../../../db/store.js';
import { plexPutStreams, triggerButlerBackup } from '../../../core/plex-client.js';
import { plexLanguageFixConfig } from '../config.js';
import type { AppliedChangeEntry, AppliedLog, AppliedStreamState, DiscoverDetail, EvaluateDetail, StreamChoice } from '../types.js';
import { ledgerSuccessRows } from './ledger.js';

export const JOB_NAME = 'plex-language-apply';
const MAX_ATTEMPTS = 3;

function toAppliedState(choice: StreamChoice | undefined): AppliedStreamState | null {
  if (!choice || choice.streamId === null) return null;
  return { streamId: choice.streamId, label: choice.label };
}

export interface PlexClientOverrides {
  putStreams?: typeof plexPutStreams;
  triggerBackup?: typeof triggerButlerBackup;
  now?: () => string;
}

/**
 * For every file evaluate marked `status: 'change'` that this stage has not yet
 * applied, applies the proposed audio (and, when set, subtitle) selection via
 * Plex's own official "PUT /library/parts/<id>" endpoint. PERMANENT idempotency:
 * once a file is recorded done here it is NEVER automatically re-touched by a
 * future run, even if evaluate's ledger row for that file is later re-flagged
 * 'change' — re-applying requires the operator to manually unstick this job's
 * ledger row for that file (POST /api/stuck/unstick). Reads its eligible work
 * directly from the evaluate/discover ledgers — there is no more
 * data/out/language-scan.json changeset file to read.
 */
export async function runApply(ctx: JobContext, opts: { appliedLogPrefix?: string } & PlexClientOverrides = {}): Promise<void> {
  const appliedLogPrefix = opts.appliedLogPrefix ?? plexLanguageFixConfig.appliedLogPrefix;
  const putStreams = opts.putStreams ?? plexPutStreams;
  const triggerBackup = opts.triggerBackup ?? triggerButlerBackup;
  const now = opts.now ?? (() => new Date().toISOString());

  ctx.log('info: plex-language-apply starting — reading eligible changes from the evaluate/discover ledgers');

  const discoveredByKey = new Map(ledgerSuccessRows('plex-language-discover').map((r) => [r.itemKey, r.detail as DiscoverDetail]));

  const qualifying: Array<{ itemKey: string; name: string; discover: DiscoverDetail; evalDetail: EvaluateDetail }> = [];
  let skipped = 0;
  for (const row of ledgerSuccessRows('plex-language-evaluate')) {
    if (!ctx.rootAllowed(row.itemKey)) continue;
    if (isWorkItemDone(JOB_NAME, row.itemKey, MAX_ATTEMPTS)) continue; // already applied, ever — never re-touched
    const evalDetail = row.detail as EvaluateDetail;
    if (evalDetail.status !== 'change') continue;
    const discover = discoveredByKey.get(row.itemKey);
    if (!discover || typeof evalDetail.proposedAudio?.streamId !== 'number') {
      skipped++;
      ctx.log(`  ⚠ skipping "${evalDetail.name}" (${row.itemKey}) — missing discover record or usable proposed audio streamId`, 'warn');
      continue;
    }
    qualifying.push({ itemKey: row.itemKey, name: evalDetail.name, discover, evalDetail });
  }

  ctx.log(`info: ${qualifying.length} file(s) qualify for apply (${skipped} skipped as malformed)`);

  let butlerBackup: { ok: boolean; error?: string } = { ok: false, error: 'no changes to apply — backup not triggered' };
  if (qualifying.length > 0) {
    ctx.log('info: triggering Plex Butler backup before applying any change (safety net)…');
    butlerBackup = await triggerBackup();
    if (butlerBackup.ok) {
      ctx.log('✓ Butler backup triggered');
    } else {
      ctx.log(`⚠ Butler backup trigger failed: ${butlerBackup.error} — continuing anyway (the per-file undo log is the primary safety net)`, 'warn');
    }
  }

  const entries: AppliedChangeEntry[] = [];
  let applied = 0;
  let failed = 0;

  for (let i = 0; i < qualifying.length; i++) {
    const { itemKey, name, discover, evalDetail } = qualifying[i];
    const beforeAudio = toAppliedState(evalDetail.currentAudio);
    const beforeSubtitle = toAppliedState(evalDetail.currentSubtitle);
    const afterAudio = toAppliedState(evalDetail.proposedAudio);
    const afterSubtitle = toAppliedState(evalDetail.proposedSubtitle);

    try {
      await putStreams(discover.partId, afterAudio!.streamId, afterSubtitle?.streamId ?? null);
      applied++;
      entries.push({
        partId: discover.partId,
        file: discover.file,
        itemTitle: name,
        beforeAudio,
        afterAudio,
        beforeSubtitle,
        afterSubtitle,
        outcome: 'applied',
        at: now(),
      });
      ctx.log(`  ✓ [${i + 1}/${qualifying.length}] "${name}" (partId=${discover.partId}) — audio → ${afterAudio?.label}${afterSubtitle ? `, subtitle → ${afterSubtitle.label}` : ''}`);
      markWorkItem(JOB_NAME, itemKey, 'success', {
        detail: { name: `${name} — applied`, path: `${appliedLogPrefix}.json`, format: 'json' },
      });
    } catch (err) {
      failed++;
      const error = err instanceof Error ? err.message : String(err);
      entries.push({
        partId: discover.partId,
        file: discover.file,
        itemTitle: name,
        beforeAudio,
        afterAudio,
        beforeSubtitle,
        afterSubtitle,
        outcome: 'failed',
        error,
        at: now(),
      });
      ctx.log(`  ✗ [${i + 1}/${qualifying.length}] "${name}" (partId=${discover.partId}) — ${error}`, 'error');
      markWorkItem(JOB_NAME, itemKey, 'failed', { detail: { name: `${name} — apply failed`, error } });
    }

    ctx.progress(Math.round(((i + 1) / Math.max(qualifying.length, 1)) * 90), `${i + 1}/${qualifying.length} applied`);
  }

  const generatedAt = now();
  const log: AppliedLog = { generatedAt, butlerBackup, entries };
  const logPath = `${appliedLogPrefix}-${generatedAt.replace(/[:.]/g, '-')}.json`;
  writeFileSync(logPath, JSON.stringify(log, null, 2));
  ctx.log(`info: wrote applied-changes log to ${logPath}`);

  ctx.log('═══════════════ APPLY SUMMARY ═══════════════');
  ctx.log(`Attempted: ${qualifying.length} · applied: ${applied} · failed: ${failed} · skipped (malformed): ${skipped}`);
  ctx.log(`Butler backup: ${butlerBackup.ok ? 'triggered' : `not triggered (${butlerBackup.error})`}`);
  ctx.log('═══════════════════════════════════════════');

  ctx.progress(100, `${applied}/${qualifying.length} applied`);

  if (failed > 0) {
    throw new Error(`${failed}/${qualifying.length} file(s) failed to apply this run — see logs above`);
  }
}
