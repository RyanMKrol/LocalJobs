/**
 * Child process entrypoint. Spawned by the executor as:
 *   node --import tsx src/runJob.ts <jobName>
 *
 * Runs the job in isolation and streams structured events as NDJSON on stdout.
 * The parent (executor) is the sole DB writer; this process only emits events.
 */
import 'dotenv/config'; // load .env so jobs can read secrets (e.g. API keys)
import { getJobDefinition } from './jobs/registry.js';
import type { JobContext, JobEvent } from './core/types.js';

function emit(event: JobEvent): void {
  process.stdout.write(JSON.stringify(event) + '\n');
}

/**
 * Emit the final result, then exit only once stdout has flushed to the OS.
 * Calling process.exit() immediately would truncate buffered stdout under a high
 * volume of log events (losing tail logs and the result itself). The write
 * callback fires after this — and therefore all prior ordered writes — flush.
 */
function emitResultAndExit(event: JobEvent, code: number): void {
  process.stdout.write(JSON.stringify(event) + '\n', () => process.exit(code));
}

async function main(): Promise<void> {
  const jobName = process.argv[2];
  const def = getJobDefinition(jobName);
  if (!def) {
    emitResultAndExit({ type: 'result', status: 'failed', error: `Unknown job: ${jobName}` }, 1);
    return;
  }

  const ctx: JobContext = {
    log: (message, level = 'info') => emit({ type: 'log', level, message }),
    progress: (pct, message = '') => emit({ type: 'progress', pct, message }),
  };

  try {
    await def.run(ctx);
    emitResultAndExit({ type: 'result', status: 'success' }, 0);
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    emitResultAndExit({ type: 'result', status: 'failed', error: message }, 1);
  }
}

main();
