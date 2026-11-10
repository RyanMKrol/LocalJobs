/**
 * "Save, then mark done": keeps a stage's hand-off file and its ledger from
 * disagreeing.
 *
 * An item-loop stage does two things per item: it adds the item's result to a
 * data file the NEXT stage reads, and it marks the item done in the `work_items`
 * ledger so it is never processed again. If the ledger mark lands first and the
 * process is killed before the file is saved, the item is "done" forever but its
 * data never reaches the next stage: silently lost. (This was real: places-enrich
 * marked each place done immediately but saved its 80 MB file only every 10
 * places.) Saving a large file after every single item is wasteful, so the fix
 * is to hold the ledger marks back until the save that covers them has happened.
 *
 * Usage:
 *
 *     const cp = createCheckpoint(() => writeJsonFile(path, data), { every: 10 });
 *     try {
 *       for (const item of todo) {
 *         data[item.id] = await work(item);
 *         cp.defer(() => markWorkItem(JOB, item.id, 'success', { ... }));
 *       }
 *     } finally {
 *       cp.flush();   // save, then apply whatever marks are still held
 *     }
 *
 * A kill between checkpoints loses at most `every - 1` items' work, and loses it
 * in the SAFE direction: those items were never marked done, so the next run
 * simply does them again.
 */
export interface Checkpoint {
  /** Queue a ledger mark. It is applied by the next flush, AFTER the save. A
   *  flush happens automatically once `every` marks are queued. */
  defer(mark: () => void): void;
  /** Save now, then apply every queued mark. Safe to call with nothing queued
   *  (it still saves, so the file reflects the latest in-memory state). */
  flush(): void;
  /** How many marks are currently held back. */
  readonly pending: number;
}

export function createCheckpoint(save: () => void, opts: { every?: number } = {}): Checkpoint {
  const every = Math.max(1, opts.every ?? 10);
  let queue: Array<() => void> = [];
  const flush = (): void => {
    // Save FIRST. If the save throws, nothing is marked and the queue is kept, so
    // a later flush (or the next run) can still get it right.
    save();
    const batch = queue;
    queue = [];
    for (const mark of batch) mark();
  };
  return {
    defer(mark) {
      queue.push(mark);
      if (queue.length >= every) flush();
    },
    flush,
    get pending() {
      return queue.length;
    },
  };
}
