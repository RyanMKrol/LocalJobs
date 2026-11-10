// Item loops: the part of a stage that works through a list one item at a time.
//
// Almost every item-processing stage is the same loop, and each used to write it
// by hand: skip what is already done, respect a run limit, count attempts, catch a
// failure and carry on, stop politely at a quota, report progress, fail the run at
// the end if anything failed. Each of those is a rule that was, somewhere, got
// wrong or left out (failures swallowed, attempts never counted, an item marked
// done before its data was saved). `eachItem` is that loop, once, so the rules are
// mechanical rather than a convention each stage must remember.
import { getWorkItem, isWorkItemDone, listSuccessWorkItems, markWorkItem, markWorkItems, pruneSnapshotRows } from '../db/store.js';
import { createCheckpoint } from './checkpoint.js';
import type { LedgerRowValue } from './ports.js';
import type { JobContext } from './types.js';

/**
 * The successful rows of a ledger, parsed: the `readRows` for a `ledgerArtifact`
 * whose data is "everything this stage has completed".
 */
export function successRows(ledgerJob: string): LedgerRowValue[] {
  return listSuccessWorkItems(ledgerJob).map((r) => ({
    itemKey: r.item_key,
    status: r.status,
    detail: r.detail ? (JSON.parse(r.detail) as unknown) : null,
  }));
}

/**
 * Stop the loop gracefully: this item was not really attempted, and nothing
 * after it can be either, for a reason that clears on its own (a daily quota, a
 * rate limit). The item is recorded `skipped` with no attempt counted, the loop
 * ends, the run SUCCEEDS, and the next run resumes here.
 *
 * Return `softStop(reason)` from a handler, or throw a `SoftStopError` (a
 * service's quota error extends it, so it propagates without any handling).
 */
export class SoftStopError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SoftStopError';
  }
}

/**
 * Stop the loop and FAIL the run: a condition no later item or later run will
 * get past on its own (a revoked key, depleted credits). The item is left
 * untouched (no attempt counted) so that it is retried once the cause is fixed.
 */
export class FatalStageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FatalStageError';
  }
}

const SOFT_STOP = Symbol('softStop');
export interface SoftStop {
  [SOFT_STOP]: true;
  reason: string;
}
/** Returned from a handler to stop the loop gracefully (see {@link SoftStopError}). */
export const softStop = (reason: string): SoftStop => ({ [SOFT_STOP]: true, reason });
const isSoftStop = (v: unknown): v is SoftStop => !!v && typeof v === 'object' && (v as SoftStop)[SOFT_STOP] === true;

export interface EachItemOptions<T> {
  /** The item's ledger key. */
  key(item: T): string;
  /** What a person calls it (used in log lines and as the row title). Defaults to the key. */
  title?(item: T): string;
  /**
   * The originating input this item descends from, for a stage whose key is not
   * the root key (see run limits). Defaults to the item's own key. Items whose
   * root is not in a limited run's selection are left alone.
   */
  root?(item: T): string;
  /**
   * The upstream ledger item this one is made FROM: the job that recorded it and
   * (when it differs from this item's key) its key there. The run page shows
   * these as the stage's inputs.
   */
  from?: { job: string; key?(item: T): string };
  /** The ledger to record under, when it is not the stage's own name. */
  ledger?: string;
  /** How many times an item may fail before it is given up on (it then shows as stuck). */
  maxAttempts: number;
  /** Attempt at most this many items this run (a per-run cap). */
  limit?: number;
  /** Pause between items (ms). */
  delayMs?: number;
  /** Give up on the run after this many failures in a row: something systemic is wrong. */
  stopAfterConsecutiveFailures?: number;
  /**
   * For a stage that adds each result to ONE shared file the next stage reads:
   * how to save that file. Items are then marked done only AFTER a save that
   * covers them (every `saveEvery` items, and at the end), so a kill can never
   * leave an item "done" whose data was not saved. A stage that writes one file
   * per item needs neither: write the file in the handler, before returning.
   */
  save?: () => void;
  saveEvery?: number;
  /** Fail the run at the end if any item failed. Default true. */
  throwOnFailed?: boolean;
}

export interface ItemInfo {
  /** This attempt's number for the item (1 = first try). */
  attempt: number;
  /** 1-based position among the items being attempted this run, and how many there are. */
  index: number;
  total: number;
}

export interface ItemTally {
  /** Items completed this run. */
  ok: number;
  /** Items that failed this run. */
  failed: number;
  /** Items attempted this run (`ok + failed`). */
  attempted: number;
  /** Items passed over because the ledger already has them done. */
  alreadyDone: number;
  /** Items outside this (limited) run's selected roots. */
  outsideLimit: number;
  /** Items left for a later run (the per-run cap, or an early stop). */
  remaining: number;
  /** Why the loop ended before the end of the list, if it did. */
  stopped: string | null;
}

/**
 * Work through `items`, calling `handler` for each one that still needs doing.
 *
 * The handler does the work and RETURNS the detail to record for the item (what
 * this stage produced for it). It can also return `softStop(reason)`, or throw:
 * a `SoftStopError` stops gracefully, a `FatalStageError` fails the run, and any
 * other error fails just that item and the loop carries on.
 *
 * In order, for every item: skipped if outside a limited run's roots; skipped if
 * the ledger already has it done; stopped at `limit`; attempted, with progress
 * and an `i/N` log line; recorded. After the loop the run fails if any item did.
 */
export async function eachItem<T>(
  ctx: JobContext,
  jobName: string,
  items: T[],
  opts: EachItemOptions<T>,
  handler: (item: T, info: ItemInfo) => Promise<Record<string, unknown> | SoftStop | void> | Record<string, unknown> | SoftStop | void,
): Promise<ItemTally> {
  const ledger = opts.ledger ?? jobName;
  const title = (item: T) => opts.title?.(item) ?? opts.key(item);
  const rootOf = (item: T) => opts.root?.(item) ?? opts.key(item);

  const inScope = items.filter((it) => ctx.rootAllowed(rootOf(it)));
  const outsideLimit = items.length - inScope.length;
  const todo = inScope.filter((it) => !isWorkItemDone(ledger, opts.key(it), opts.maxAttempts));
  const alreadyDone = inScope.length - todo.length;
  const total = opts.limit && opts.limit > 0 ? Math.min(todo.length, opts.limit) : todo.length;

  ctx.log(
    `${items.length} item(s): ${alreadyDone} already done` +
      (outsideLimit ? `, ${outsideLimit} outside this run's limit` : '') +
      `, ${todo.length} to do` +
      (total < todo.length ? ` (attempting ${total} this run)` : ''),
  );

  // With a shared file to save, hold each ledger mark until a save has covered it.
  const checkpoint = opts.save ? createCheckpoint(opts.save, { every: opts.saveEvery ?? 10 }) : null;
  const mark = (fn: () => void) => (checkpoint ? checkpoint.defer(fn) : fn());
  const lineage = (item: T) => ({
    rootKey: opts.root ? opts.root(item) : undefined,
    from: opts.from ? { job: opts.from.job, key: opts.from.key?.(item) ?? opts.key(item) } : undefined,
    title: title(item),
  });

  const tally: ItemTally = { ok: 0, failed: 0, attempted: 0, alreadyDone, outsideLimit, remaining: 0, stopped: null };
  let consecutiveFailures = 0;
  let fatal: unknown = null;

  try {
    for (let i = 0; i < total; i++) {
      const item = todo[i];
      const key = opts.key(item);
      const attempt = (getWorkItem(ledger, key)?.attempts ?? 0) + 1;
      const where = `[${i + 1}/${total}]`;

      const stopSoftly = (reason: string) => {
        tally.stopped = reason;
        // Not an attempt: the count is left where it was, and the next run resumes here.
        mark(() => markWorkItem(ledger, key, 'skipped', { attempts: attempt - 1, detail: { name: title(item), stopped: reason }, ...lineage(item) }));
        ctx.log(`${where} stopping early at "${title(item)}" — ${reason}. The next run resumes here.`, 'warn');
      };

      let result: Record<string, unknown> | SoftStop | void;
      try {
        result = await handler(item, { attempt, index: i + 1, total });
      } catch (err) {
        if (err instanceof FatalStageError) {
          fatal = err;
          ctx.log(`${where} "${title(item)}" — ${err.message}. This will not clear on its own: failing the run.`, 'error');
          break;
        }
        if (err instanceof SoftStopError) {
          stopSoftly(err.message);
          break;
        }
        const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
        mark(() => markWorkItem(ledger, key, 'failed', { attempts: attempt, detail: { name: title(item), error: message }, ...lineage(item) }));
        tally.failed++;
        tally.attempted++;
        consecutiveFailures++;
        const outlook = attempt >= opts.maxAttempts ? 'giving up (it will show as stuck)' : `will retry (attempt ${attempt}/${opts.maxAttempts})`;
        ctx.log(`${where} ✗ "${title(item)}" — ${message}; ${outlook}`, 'warn');
        ctx.progress(((i + 1) / total) * 100, `${tally.ok} done, ${tally.failed} failed of ${total}`);
        if (opts.stopAfterConsecutiveFailures && consecutiveFailures >= opts.stopAfterConsecutiveFailures) {
          tally.stopped = `${consecutiveFailures} failures in a row`;
          ctx.log(`${consecutiveFailures} failures in a row — stopping the run rather than working through the rest. Investigate.`, 'error');
          break;
        }
        if (opts.delayMs && i < total - 1) await new Promise((r) => setTimeout(r, opts.delayMs));
        continue;
      }

      if (isSoftStop(result)) {
        stopSoftly(result.reason);
        break;
      }

      // Success. The handler has already persisted the item's data (or `save`
      // will before this mark is applied): the mark comes last.
      const detail = { name: title(item), ...(result ?? {}) };
      mark(() => markWorkItem(ledger, key, 'success', { attempts: attempt, detail, ...lineage(item) }));
      tally.ok++;
      tally.attempted++;
      consecutiveFailures = 0;
      ctx.log(`${where} ✓ "${title(item)}"`);
      ctx.progress(((i + 1) / total) * 100, `${tally.ok} done${tally.failed ? `, ${tally.failed} failed` : ''} of ${total}`);
      if (opts.delayMs && i < total - 1) await new Promise((r) => setTimeout(r, opts.delayMs));
    }
  } finally {
    // Save, then apply whatever marks are still held, on every way out.
    checkpoint?.flush();
  }

  tally.remaining = todo.length - tally.attempted;
  if (!tally.stopped && total < todo.length) tally.stopped = `per-run limit of ${opts.limit} reached`;
  ctx.log(
    `Done: ${tally.ok} completed, ${tally.failed} failed` +
      (tally.remaining ? `, ${tally.remaining} left for a later run` : '') +
      (tally.stopped ? ` (stopped: ${tally.stopped})` : ''),
  );
  if (total === 0) ctx.progress(100, 'nothing to do');

  if (fatal) throw fatal;
  if (tally.failed > 0 && opts.throwOnFailed !== false) {
    throw new Error(`${tally.failed}/${tally.attempted} item(s) failed this run — see the ✗ lines above`);
  }
  return tally;
}

export interface SnapshotEntry {
  key: string;
  detail: unknown;
  /** The originating input, for a stage whose key is not the root key. */
  root?: string;
  /** The upstream ledger item this entry was derived from. */
  from?: { job: string; key?: string };
  /** Defaults to `success`. */
  status?: 'success' | 'failed' | 'skipped';
}

/**
 * Re-record a whole SNAPSHOT ledger: a stage that describes "everything as it is
 * right now" on every run (a library walk, a plan derived from it), as opposed to
 * a stage that does each item once.
 *
 * Writes every entry in batched transactions, and reports how many were new,
 * changed or identical: only new and changed ones count as this run's work (an
 * unchanged catalogue re-recorded is not something the run "did"). With
 * `prune`, rows whose keys are no longer present are removed.
 *
 * `prune` must be used with care: only on an UNLIMITED run, only when the walk
 * that produced `entries` was COMPLETE (a walk that failed to read part of its
 * source did not see those items; it does not mean they are gone), and never on a
 * ledger whose rows record work done once (pruning those would re-arm it).
 */
export function snapshotLedger(
  ctx: JobContext,
  jobName: string,
  entries: SnapshotEntry[],
  opts: { prune?: boolean; ledger?: string } = {},
): { added: number; changed: number; unchanged: number; removed: number; outsideLimit: number } {
  const ledger = opts.ledger ?? jobName;
  const inScope = entries.filter((e) => ctx.rootAllowed(e.root ?? e.key));
  const outsideLimit = entries.length - inScope.length;
  const tally = markWorkItems(
    ledger,
    inScope.map((e) => ({ key: e.key, status: e.status ?? ('success' as const), detail: e.detail, rootKey: e.root, from: e.from })),
  );
  let removed = 0;
  if (opts.prune) {
    if (ctx.selectedRoots() !== null) {
      ctx.log('Not pruning: this is a limited run, which only re-records its selected roots.', 'warn');
    } else {
      removed = pruneSnapshotRows(ledger, entries.map((e) => e.key));
    }
  }
  ctx.log(
    `Snapshot recorded: ${tally.added} new, ${tally.changed} changed, ${tally.unchanged} unchanged` +
      (removed ? `, ${removed} no longer present (removed)` : '') +
      (outsideLimit ? `, ${outsideLimit} outside this run's limit` : ''),
  );
  return { ...tally, removed, outsideLimit };
}
