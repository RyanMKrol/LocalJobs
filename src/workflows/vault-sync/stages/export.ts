import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { JobContext } from '../../../core/types.js';
import {
  fromStoredPath,
  getWorkItem,
  listSuccessWorkItems,
  markWorkItem,
  type WorkItemRow,
} from '../../../db/store.js';
import { vaultSyncConfig } from '../config.js';
import { SOURCE_JOBS, sanitizeFilename, vaultTargetFor, type SourceJob } from '../lib.js';

export const JOB_NAME = 'vault-sync-export';

/** The exporter's own ledger key for one source item. */
export function exportKeyFor(sourceJob: string, itemKey: string): string {
  return `${sourceJob}::${itemKey}`;
}

/** What the exporter records on its own success rows. */
interface ExporterDetail {
  name?: string;
  markdown?: string;
  /** Vault-relative path of the copy (POSIX slashes). Absent on a deliberate skip. */
  vaultPath?: string;
  /** The source ledger row's `updated_at` at copy time — the re-sync marker. */
  sourceUpdatedAt?: string;
  /** Legacy: old workouts months were closed out with a "content unrecoverable"
   *  note back when the source was a single overwritten slot file. Nothing
   *  writes this anymore (per-month files since 2026-08), but old rows keep it. */
  note?: string;
}

function parseDetail(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

interface Candidate {
  sourceJob: SourceJob;
  row: WorkItemRow;
  exportKey: string;
  name: string | null;
  /** Stored (workflows-root-relative) source markdown path. */
  storedMarkdown: string;
  reason: 'new' | 'source updated' | 'vault copy missing';
  /** The previously recorded vault path, for rename/orphan detection. */
  priorVaultPath: string | null;
}

export interface VaultExportOpts {
  /** Override the vault directory (tests). Defaults to config. */
  vaultDir?: string;
  /** Override the source job list (tests). Defaults to all five. */
  sourceJobs?: readonly SourceJob[];
}

export interface VaultExportResult {
  synced: number;
  unchanged: number;
  failed: number;
}

/**
 * Mirror the five source workflows' markdown output into the vault folder.
 * Copy-only, overwrite-on-change, never deletes. Re-copy decisions come from
 * the exporter's own work_items ledger (key `<sourceJob>::<sourceItemKey>`):
 * an item is synced when it has no exporter row yet, when the source row's
 * `updated_at` has moved past the stored `sourceUpdatedAt` marker, or when the
 * vault copy has been deleted by hand. Every source (including workouts, which
 * writes per-month files since 2026-08) keeps one surviving file per ledger
 * row, so no source needs special-casing; legacy workouts rows that were
 * closed out as unrecoverable under the old single-slot layout simply stay
 * unchanged forever.
 */
export async function runVaultExport(ctx: JobContext, opts: VaultExportOpts = {}): Promise<VaultExportResult> {
  const vaultDir = opts.vaultDir ?? vaultSyncConfig.vaultDir;
  const sourceJobs = opts.sourceJobs ?? SOURCE_JOBS;
  mkdirSync(vaultDir, { recursive: true });

  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log(`vault-sync starting — vault: ${vaultDir}`);
  ctx.log(`Sources: ${sourceJobs.join(', ')}`);

  // ── Classify every source row: sync / unchanged ──
  const toSync: Candidate[] = [];
  let unchanged = 0;
  let noPath = 0;

  for (const sourceJob of sourceJobs) {
    const rows = listSuccessWorkItems(sourceJob);
    ctx.log(`${sourceJob}: ${rows.length} completed item(s) in the source ledger`);

    for (const row of rows) {
      const exportKey = exportKeyFor(sourceJob, row.item_key);
      if (!ctx.rootAllowed(exportKey)) continue;

      const sourceDetail = parseDetail(row.detail);
      const name = typeof sourceDetail.name === 'string' ? sourceDetail.name : null;
      const storedMarkdown = typeof sourceDetail.markdown === 'string' ? sourceDetail.markdown : null;
      if (!storedMarkdown) {
        ctx.log(`  ${exportKey}: source row has no detail.markdown — nothing to copy, skipping`, 'warn');
        noPath += 1;
        continue;
      }

      const exporterRow = getWorkItem(JOB_NAME, exportKey);
      const exporterDetail = (exporterRow ? parseDetail(exporterRow.detail) : {}) as ExporterDetail;

      const priorVaultPath = exporterDetail.vaultPath ?? null;
      let reason: Candidate['reason'] | null = null;
      if (!exporterRow || exporterRow.status !== 'success') reason = 'new';
      else if (exporterDetail.sourceUpdatedAt !== row.updated_at) reason = 'source updated';
      else if (priorVaultPath && !existsSync(join(vaultDir, priorVaultPath))) reason = 'vault copy missing';

      if (reason === null) {
        unchanged += 1;
        continue;
      }
      toSync.push({ sourceJob, row, exportKey, name, storedMarkdown, reason, priorVaultPath });
    }
  }

  ctx.log(`Plan: ${toSync.length} to sync, ${unchanged} unchanged, ${noPath} with no source path.`);

  // ── Collision map: vault-relative path -> export key, seeded from every ──
  // ── existing exporter row so names stay stable across runs.             ──
  const usedNames = new Map<string, string>();
  for (const row of listSuccessWorkItems(JOB_NAME)) {
    const detail = parseDetail(row.detail) as ExporterDetail;
    if (detail.vaultPath) usedNames.set(detail.vaultPath, row.item_key);
  }

  // ── Copy loop ──
  let synced = 0;
  let failed = 0;
  const total = toSync.length;
  for (let i = 0; i < total; i += 1) {
    const item = toSync[i];
    try {
      const sourceAbs = fromStoredPath(item.storedMarkdown);
      const content = readFileSync(sourceAbs, 'utf8');

      const target = vaultTargetFor(item.sourceJob, item.row.item_key, item.name, () => content);
      let vaultPath = `${target.folder}/${target.baseName}.md`;
      const takenBy = usedNames.get(vaultPath);
      if (takenBy !== undefined && takenBy !== item.exportKey) {
        // A different item already owns this pretty name — disambiguate with a
        // stable suffix derived from the source item key.
        const suffix = sanitizeFilename(item.row.item_key, item.row.item_key);
        vaultPath = `${target.folder}/${target.baseName} (${suffix}).md`;
        ctx.log(`  ${item.exportKey}: name "${target.baseName}" taken by ${takenBy} — using "${vaultPath}"`);
      }
      if (item.priorVaultPath && item.priorVaultPath !== vaultPath) {
        ctx.log(`  ${item.exportKey}: vault name changed from "${item.priorVaultPath}" to "${vaultPath}" — the old file is now orphaned (never deleted automatically)`, 'warn');
      }

      const destAbs = join(vaultDir, vaultPath);
      mkdirSync(dirname(destAbs), { recursive: true });
      writeFileSync(destAbs, content);
      usedNames.set(vaultPath, item.exportKey);

      markWorkItem(JOB_NAME, item.exportKey, 'success', {
        detail: {
          name: target.baseName,
          markdown: sourceAbs, // the SOURCE path — store relativizes it (T447); dashboard View previews the source
          vaultPath,
          sourceUpdatedAt: item.row.updated_at,
        } satisfies ExporterDetail,
      });
      synced += 1;
      ctx.log(`  [${i + 1}/${total}] ${item.exportKey} → ${vaultPath} (${item.reason})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      markWorkItem(JOB_NAME, item.exportKey, 'failed', {
        detail: { name: item.name ?? item.row.item_key, error: message },
      });
      failed += 1;
      ctx.log(`  [${i + 1}/${total}] ${item.exportKey}: FAILED — ${message}`, 'error');
    }
    ctx.progress(Math.round(((i + 1) / total) * 100), `${i + 1}/${total} synced`);
  }

  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log(`vault-sync done: ${synced} copied, ${unchanged} unchanged, ${failed} failed.`);
  ctx.progress(100, `${synced} copied, ${unchanged} unchanged`);

  // Item-loop rule (T416): a run that failed any item must fail itself so the
  // run is recorded failed and retried; already-synced items are skipped there.
  if (failed > 0) {
    throw new Error(`${failed}/${total} item(s) failed this run — see logs above`);
  }
  return { synced, unchanged, failed };
}
