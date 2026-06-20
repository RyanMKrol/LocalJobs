/**
 * Child process entrypoint. Spawned by the executor as:
 *   node --import tsx src/runJob.ts <jobName>
 *
 * Runs the job in isolation and streams structured events as NDJSON on stdout.
 * The parent (executor) is the sole DB writer; this process only emits events.
 */
import { getJobDefinition } from './jobs/registry.js';
import type { JobContext, JobEvent } from './core/types.js';

function emit(event: JobEvent): void {
  process.stdout.write(JSON.stringify(event) + '\n');
}

async function main(): Promise<void> {
  const jobName = process.argv[2];
  const def = getJobDefinition(jobName);
  if (!def) {
    emit({ type: 'result', status: 'failed', error: `Unknown job: ${jobName}` });
    process.exit(1);
  }

  const ctx: JobContext = {
    log: (message, level = 'info') => emit({ type: 'log', level, message }),
    progress: (pct, message = '') => emit({ type: 'progress', pct, message }),
  };

  try {
    await def.run(ctx);
    emit({ type: 'result', status: 'success' });
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    emit({ type: 'result', status: 'failed', error: message });
    process.exit(1);
  }
}

main();
