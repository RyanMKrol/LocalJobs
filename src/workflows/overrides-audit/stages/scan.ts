import { mkdirSync, writeFileSync } from 'node:fs';
import type { JobContext } from '../../../core/types.js';
import { listStaleOverrides, markWorkItem } from '../../../db/store.js';
import { overridesAuditConfig } from '../config.js';
import type { StaleOverrideReportRow, StaleOverridesReport } from '../types.js';

export const JOB_NAME = 'overrides-audit-scan';

/** "2026-W27" — the ISO-8601 week key, used as the ledger key. Mirrors plex-space-saver's weekKey. */
export function weekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

/** Render a millisecond age as a short human string, e.g. "23 day(s)". */
export function formatAge(ageMs: number | null): string {
  if (ageMs === null) return 'unknown (since before this feature existed)';
  const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  return `${days} day(s)`;
}

export interface ScanOpts {
  /** Override "now" (tests). Defaults to a fresh Date. */
  now?: Date;
  /** Override the staleness threshold (tests). Defaults to config's minAgeMs. */
  minAgeMs?: number;
}

/**
 * Single-stage, report-only audit: reads every currently-set `_overridden` flag
 * across services/workflows/jobs via `listStaleOverrides` and writes a report
 * naming each one that's either unknown-age or has been live 2+ weeks — a
 * reminder to fold a stable override into its manifest/service-definition code
 * default (see the root CLAUDE.md Conventions section). Never notifies, never
 * writes to IDEAS.jsonl, and never patches any manifest file itself — folding an
 * override into code stays a fully manual step the owner does by hand.
 *
 * Idempotent per ISO calendar week via the work_items ledger (mirrors
 * plex-space-saver): a manual re-run the same week regenerates that week's
 * report rather than duplicating it. Runs weekly.
 */
export async function runScan(ctx: JobContext, opts: ScanOpts = {}): Promise<void> {
  mkdirSync(overridesAuditConfig.outDir, { recursive: true });
  const now = opts.now ?? new Date();
  const minAgeMs = opts.minAgeMs ?? overridesAuditConfig.minAgeMs;

  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log(`overrides-audit-scan starting — threshold ${Math.round(minAgeMs / (24 * 60 * 60 * 1000))} day(s)`);

  ctx.progress(30, 'reading override flags');
  const stale = listStaleOverrides(minAgeMs);
  ctx.log(`Found ${stale.length} stale/unknown-age override(s) across services/workflows/jobs.`);

  ctx.progress(70, 'building report');
  const items: StaleOverrideReportRow[] = stale
    .map((s) => ({
      table: s.table,
      name: s.name,
      field: s.field,
      currentValue: s.currentValue,
      overriddenAt: s.overriddenAt,
      ageHuman: formatAge(s.ageMs),
    }))
    .sort((a, b) => a.table.localeCompare(b.table) || a.name.localeCompare(b.name) || a.field.localeCompare(b.field));

  for (const item of items) {
    ctx.log(`  ${item.table}.${item.name}.${item.field} = ${JSON.stringify(item.currentValue)} — overridden ${item.ageHuman}`);
  }

  const report: StaleOverridesReport = {
    generatedAt: now.toISOString(),
    minAgeDays: Math.round(minAgeMs / (24 * 60 * 60 * 1000)),
    count: items.length,
    items,
  };

  writeFileSync(overridesAuditConfig.reportOut, JSON.stringify(report, null, 2));
  ctx.log(`Wrote ${overridesAuditConfig.reportOut}`);

  // Idempotent per ISO week (report-only; a re-run the same week regenerates it).
  // Declared output form (T262/T282): JSON, served from detail.path via
  // safeOutputFile through the unified Output section.
  const key = weekKey(now);
  markWorkItem(JOB_NAME, key, 'success', {
    detail: {
      name: `Stale overrides report — ${key}`,
      format: 'json',
      path: overridesAuditConfig.reportOut,
    },
  });

  ctx.progress(100, `${items.length} stale override(s) reported`);
}
