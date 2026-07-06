import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import type { JobContext } from '../../../core/types.js';
import { markWorkItem } from '../../../db/store.js';
import { plexPutStreams, triggerButlerBackup } from '../../../core/plex-client.js';
import { plexLanguageFixConfig } from '../config.js';
import type { AppliedChangeEntry, AppliedLog, AppliedStreamState, FileEntry, LanguageScanFile, StreamChoice } from '../types.js';

export const JOB_NAME = 'plex-language-apply';

function toAppliedState(choice: StreamChoice | undefined): AppliedStreamState | null {
  if (!choice || choice.streamId === null) return null;
  return { streamId: choice.streamId, label: choice.label };
}

/** A qualifying entry needs a real change status AND a usable proposed audio stream id. */
function isEligible(f: FileEntry): boolean {
  return f.status === 'change' && typeof f.proposedAudio?.streamId === 'number';
}

export interface PlexClientOverrides {
  putStreams?: typeof plexPutStreams;
  triggerBackup?: typeof triggerButlerBackup;
  now?: () => string;
}

export async function runApply(
  ctx: JobContext,
  opts: { scanPath?: string; appliedLogPrefix?: string } & PlexClientOverrides = {},
): Promise<void> {
  const scanPath = opts.scanPath ?? plexLanguageFixConfig.scanOut;
  const appliedLogPrefix = opts.appliedLogPrefix ?? plexLanguageFixConfig.appliedLogPrefix;
  const putStreams = opts.putStreams ?? plexPutStreams;
  const triggerBackup = opts.triggerBackup ?? triggerButlerBackup;
  const now = opts.now ?? (() => new Date().toISOString());

  ctx.log(`info: plex-language-apply starting — reading scan from ${scanPath}`);

  if (!existsSync(scanPath)) {
    throw new Error(`Scan output missing: ${scanPath} — run plex-language-scan first.`);
  }
  const scan = JSON.parse(readFileSync(scanPath, 'utf8')) as LanguageScanFile;

  const qualifying: Array<{ item: string; file: FileEntry }> = [];
  let skipped = 0;
  for (const item of scan.items) {
    for (const file of item.files) {
      if (file.status !== 'change') continue;
      if (!isEligible(file)) {
        skipped++;
        ctx.log(`  ⚠ skipping "${item.title}" partId=${file.partId} — malformed proposed audio (no usable streamId)`, 'warn');
        continue;
      }
      qualifying.push({ item: item.title, file });
    }
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
    const { item, file } = qualifying[i];
    const beforeAudio = toAppliedState(file.currentAudio);
    const beforeSubtitle = toAppliedState(file.currentSubtitle);
    const afterAudio = toAppliedState(file.proposedAudio);
    const afterSubtitle = toAppliedState(file.proposedSubtitle);

    try {
      await putStreams(file.partId, afterAudio!.streamId, afterSubtitle?.streamId ?? null);
      applied++;
      entries.push({
        partId: file.partId,
        file: file.file,
        itemTitle: item,
        beforeAudio,
        afterAudio,
        beforeSubtitle,
        afterSubtitle,
        outcome: 'applied',
        at: now(),
      });
      ctx.log(`  ✓ [${i + 1}/${qualifying.length}] "${item}" (partId=${file.partId}) — audio → ${afterAudio?.label}${afterSubtitle ? `, subtitle → ${afterSubtitle.label}` : ''}`);
      markWorkItem(JOB_NAME, String(file.partId), 'success', {
        detail: {
          name: `${item} — applied`,
          path: `${appliedLogPrefix}.json`,
          format: 'json',
        },
      });
    } catch (err) {
      failed++;
      const error = err instanceof Error ? err.message : String(err);
      entries.push({
        partId: file.partId,
        file: file.file,
        itemTitle: item,
        beforeAudio,
        afterAudio,
        beforeSubtitle,
        afterSubtitle,
        outcome: 'failed',
        error,
        at: now(),
      });
      ctx.log(`  ✗ [${i + 1}/${qualifying.length}] "${item}" (partId=${file.partId}) — ${error}`, 'error');
      markWorkItem(JOB_NAME, String(file.partId), 'failed', { detail: { name: `${item} — apply failed`, error } });
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
