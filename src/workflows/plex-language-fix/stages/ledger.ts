// Direct read access to the work_items ledger for this workflow's own stages
// (T453). The stages chain purely through the ledger (no shared file): each one
// reads the success rows of the stage before it. This helper queries the
// already-exported `db` handle directly, a deliberate exception to "all SQL goes
// through store.ts" that is confined to this file. It predates
// `listSuccessWorkItems` in the store and `successRows` in the engine, which do
// the same job. Read-only, no paid/remote call.
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

/** Count of 'success' rows for a job: a cheap existence/non-empty check. */
export function ledgerSuccessCount(jobName: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM work_items WHERE job_name = ? AND status = 'success'`).get(jobName) as {
    n: number;
  };
  return row.n;
}
