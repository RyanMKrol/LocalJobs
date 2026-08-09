// Direct read access to the work_items ledger for this workflow's own stages —
// the same deliberate, scope-confined exception to "all SQL goes through
// store.ts" that plex-language-fix's stages/ledger.ts documents: these stages
// chain purely through the ledger (no shared file), and store.ts has no generic
// "every success row for a job" query. Read-only, no paid/remote call — safe to
// call from a gate contract's check() too.
import { db } from '../../../db/index.js';

export interface LedgerSuccessRow {
  itemKey: string;
  detail: unknown;
}

/** Every 'success' row currently recorded for a job, with its parsed detail. */
export function ledgerSuccessRows(jobName: string): LedgerSuccessRow[] {
  const rows = db
    .prepare(`SELECT item_key, detail FROM work_items WHERE job_name = ? AND status = 'success' ORDER BY item_key`)
    .all(jobName) as { item_key: string; detail: string | null }[];
  return rows.map((r) => ({ itemKey: r.item_key, detail: r.detail ? (JSON.parse(r.detail) as unknown) : undefined }));
}

/** Count of 'success' rows for a job — cheap existence/non-empty check for gates. */
export function ledgerSuccessCount(jobName: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM work_items WHERE job_name = ? AND status = 'success'`).get(jobName) as {
    n: number;
  };
  return row.n;
}
