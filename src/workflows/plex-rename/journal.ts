// The WRITE-AHEAD journal — the primary file-level safety net (Plex Butler
// only backs up the Plex database, never the files). Per real apply run, one
// NDJSON file under data/out/journal/: every intended operation is appended
// AND fsync'd BEFORE its filesystem effect runs, completion records after,
// and the apply ledger's success mark only happens after the item's terminal
// record is flushed — so: ledger success ⟹ journal complete, and an
// incomplete journal ⟹ the item never marked, so it is reconciled + resumed.
// A journal file EXISTS only when real mutations were intended (rehearsal mode
// writes none), so its presence always means "real intent" — the undo script
// leans on that.
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { MoveStep } from './move.js';

// ── Planned operations (LOCAL absolute paths — journal is an executable record) ──

export type JournalOp =
  | { op: 'mkdir'; path: string }
  | { op: 'write-plexmatch'; path: string; content: string; priorContent: string | null }
  | {
      op: 'move';
      from: string;
      to: string;
      partial: string;
      role: 'media' | 'sidecar' | 'asset';
      bytes?: number;
      caseOnly?: boolean;
      /** 'rename' = same-share atomic rename (metadata-only, no partial ever
       *  exists); 'copy-verify' (or absent, the pre-strategy default) = the
       *  full copy → checksum-verify → delete-original procedure. */
      strategy?: 'rename' | 'copy-verify';
    }
  | { op: 'rmdir-if-empty'; path: string };

export type JournalRecord =
  | {
      kind: 'run-start';
      at: string;
      applyEnabled: true;
      dailyCap: number;
      pathMap: { plex: string; local: string }[];
      mountsChecked: Record<string, boolean>;
    }
  | {
      kind: 'item-planned';
      at: string;
      itemKey: string;
      ratingKey: string;
      partId: number;
      title: string;
      /** Plex-side from/to (for refresh targeting + human reading; ops carry local paths). */
      from: string;
      to: string;
      ops: JournalOp[];
    }
  | { kind: 'op-attempt'; at: string; itemKey: string; opIndex: number; step?: MoveStep }
  | { kind: 'op-done'; at: string; itemKey: string; opIndex: number; step?: MoveStep; sha256?: string; bytes?: number }
  | { kind: 'op-failed'; at: string; itemKey: string; opIndex: number; step?: MoveStep; error: string }
  | { kind: 'item-done'; at: string; itemKey: string }
  | { kind: 'item-aborted'; at: string; itemKey: string; error: string; completedOps: number }
  | { kind: 'run-end'; at: string; attempted: number; applied: number; failed: number };

export const JOURNAL_PREFIX = 'rename-journal-';

export function journalFileName(now: Date): string {
  return `${JOURNAL_PREFIX}${now.toISOString().replace(/[:.]/g, '-')}.ndjson`;
}

/** Newest journal in a directory by filename sort (ISO timestamps sort lexically), or null. */
export function findLatestJournal(dir: string): string | null {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.startsWith(JOURNAL_PREFIX) && n.endsWith('.ndjson'));
  } catch {
    return null;
  }
  if (names.length === 0) return null;
  names.sort();
  return join(dir, names[names.length - 1]);
}

/**
 * Append-only, fsync-per-record journal writer. The fd is opened once; the
 * journal DIRECTORY is fsync'd right after creation so the file's directory
 * entry itself survives a crash (a journal that vanishes with the crash it was
 * supposed to explain is no journal at all).
 */
export class JournalWriter {
  private fd: number;
  readonly path: string;

  constructor(dir: string, now: Date = new Date()) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, journalFileName(now));
    this.fd = openSync(this.path, 'a');
    const dirFd = openSync(dir, 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  }

  /** Append one record and fsync before returning — the write-AHEAD guarantee. */
  append(record: JournalRecord): void {
    writeSync(this.fd, `${JSON.stringify(record)}\n`);
    fsyncSync(this.fd);
  }

  close(): void {
    closeSync(this.fd);
  }
}

/** Parse a journal file, tolerating a trailing half-written line (crash artifact). */
export function readJournal(path: string): JournalRecord[] {
  const raw = readFileSync(path, 'utf8');
  const records: JournalRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as JournalRecord);
    } catch {
      // A torn final line is expected after a crash — everything before it is intact.
    }
  }
  return records;
}

// ── Pure reconciliation analysis ──────────────────────────────────────────────

export interface ItemJournalState {
  itemKey: string;
  planned: Extract<JournalRecord, { kind: 'item-planned' }>;
  /** Terminal state as recorded: complete, aborted, or unresolved (crash mid-item). */
  outcome: 'complete' | 'aborted' | 'unresolved';
  /** Per-op progress: for each planned op index, the completed steps / done flag. */
  ops: { doneSteps: MoveStep[]; done: boolean; attempted: boolean; failed: boolean }[];
}

export interface JournalAnalysis {
  hasRunEnd: boolean;
  items: ItemJournalState[];
  /** Items with no terminal record — the crash-recovery worklist. */
  unresolved: ItemJournalState[];
}

/** Classify a journal's items — pure; the disk-reconciliation decisions live with the caller. */
export function analyzeJournal(records: JournalRecord[]): JournalAnalysis {
  const items = new Map<string, ItemJournalState>();
  let hasRunEnd = false;
  for (const r of records) {
    switch (r.kind) {
      case 'run-start':
        break;
      case 'run-end':
        hasRunEnd = true;
        break;
      case 'item-planned':
        items.set(r.itemKey, {
          itemKey: r.itemKey,
          planned: r,
          outcome: 'unresolved',
          ops: r.ops.map(() => ({ doneSteps: [], done: false, attempted: false, failed: false })),
        });
        break;
      case 'op-attempt': {
        const item = items.get(r.itemKey);
        if (item?.ops[r.opIndex]) item.ops[r.opIndex].attempted = true;
        break;
      }
      case 'op-done': {
        const item = items.get(r.itemKey);
        const op = item?.ops[r.opIndex];
        if (!op) break;
        if (r.step) {
          op.doneSteps.push(r.step);
          // A move op is fully done once its LAST step completed: 'finalize'
          // for an atomic same-share rename (its only step) and for case-only
          // copy-verify (which runs it last); 'delete-source' otherwise.
          const planned = item!.planned.ops[r.opIndex];
          if (planned.op === 'move') {
            const lastStep: MoveStep = planned.strategy === 'rename' || planned.caseOnly ? 'finalize' : 'delete-source';
            if (r.step === lastStep) op.done = true;
          }
        } else {
          op.done = true;
        }
        break;
      }
      case 'op-failed': {
        const item = items.get(r.itemKey);
        if (item?.ops[r.opIndex]) item.ops[r.opIndex].failed = true;
        break;
      }
      case 'item-done': {
        const item = items.get(r.itemKey);
        if (item) item.outcome = 'complete';
        break;
      }
      case 'item-aborted': {
        const item = items.get(r.itemKey);
        if (item) item.outcome = 'aborted';
        break;
      }
    }
  }
  const all = [...items.values()];
  return { hasRunEnd, items: all, unresolved: all.filter((i) => i.outcome === 'unresolved') };
}
