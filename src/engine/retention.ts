// Background retention sweep: trims the per-run I/O detail of old workflow runs
// (see `pruneRunHistoryChunk` in the store for exactly what is and is not kept).
// Started once by the daemon; never run by a child job process.
import { config } from '../config.js';
import { pruneRunHistoryChunk } from '../db/store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Pause between chunks, so a long sweep never holds the write lock back to back. */
const CHUNK_GAP_MS = 100;

let timer: NodeJS.Timeout | null = null;
let stopped = false;

/** Run one full sweep (chunk after chunk until nothing is left). Resolves with rows deleted. */
export async function sweepRunHistory(log: (m: string) => void = () => {}): Promise<number> {
  let total = 0;
  for (;;) {
    if (stopped) break;
    const { deleted, done } = pruneRunHistoryChunk({
      keepDays: config.runHistoryKeepDays,
      keepRunsPerWorkflow: config.runHistoryKeepRuns,
    });
    total += deleted;
    if (done) break;
    await new Promise((r) => setTimeout(r, CHUNK_GAP_MS));
  }
  if (total > 0) {
    log(
      `[retention] removed ${total} per-run I/O row(s) from workflow runs older than ${config.runHistoryKeepDays} days ` +
        `(always keeping each workflow's last ${config.runHistoryKeepRuns} runs; runs, logs and the ledger are untouched)`,
    );
  }
  return total;
}

/**
 * Start the retention loop: a first sweep shortly after startup, then one a day.
 * A sweep that throws is logged and retried at the next tick; it never takes the
 * daemon down.
 */
export function startRetention(log: (m: string) => void = console.log): void {
  stopped = false;
  const tick = () => {
    sweepRunHistory(log)
      .catch((e) => log(`[retention] sweep failed (will retry tomorrow): ${e instanceof Error ? e.message : e}`))
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, DAY_MS);
        timer?.unref();
      });
  };
  timer = setTimeout(tick, 60_000);
  timer.unref();
}

export function stopRetention(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}
