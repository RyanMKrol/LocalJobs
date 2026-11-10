// The body of the child job process: run ONE job and report how it went.
//
// Split out of `src/runJob.ts` (the real entrypoint, which looks jobs up in the
// registry) so a test can run fixture stages through exactly the same code with
// its own lookup, in a real child process, without loading every workflow.
import { getWorkflowRunRoots } from '../db/store.js';
import { takeFault } from './faults.js';
import { isPortsJob } from './ports.js';
import { assertDaemonSupportsPorts, createStageRuntime, readRunIdentity } from './stage-runtime.js';
import type { JobContext, JobDefinition, JobEvent } from './types.js';

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

export async function runJobProcess(
  jobName: string,
  getDef: (name: string) => JobDefinition | undefined,
): Promise<void> {
  const def = getDef(jobName);
  if (!def) {
    emitResultAndExit({ type: 'result', status: 'failed', error: `Unknown job: ${jobName}` }, 1);
    return;
  }

  // Run-limit lineage (T094): when this child is a member of a LIMITED workflow
  // run, the parent passes the workflow run id via env; load its frozen
  // originating-input allowlist so the job can skip items outside the selected
  // roots. Absent env / unlimited run → null set → rootAllowed always true
  // (standalone + unlimited runs behave exactly as before).
  const wfRunId = process.env.LOCALJOBS_WORKFLOW_RUN_ID || null;
  const roots = wfRunId ? getWorkflowRunRoots(wfRunId) : null;
  const rootSet: ReadonlySet<string> | null = roots ? new Set(roots) : null;

  const ctx: JobContext = {
    log: (message, level = 'info') => emit({ type: 'log', level, message }),
    progress: (pct, message = '') => emit({ type: 'progress', pct, message }),
    selectedRoots: () => rootSet,
    rootAllowed: (rootKey) => !rootSet || rootSet.has(rootKey),
  };

  try {
    // A fault written to the faults file for this stage (see faults.ts): used to
    // prove failure handling on a real run. Nothing happens without that file.
    const fault = takeFault(def.name);
    if (fault) ctx.log(`⚠ INJECTED FAULT "${fault}" for this attempt (from the engine faults file). This is a deliberate test, not a real failure.`, 'warn');
    if (fault === 'fail') throw new Error(`injected fault: stage "${def.name}" was made to fail for a test`);

    if (isPortsJob(def)) {
      // A ports stage: hand it its resolved inputs, and when it returns make sure
      // every output it declares was committed this run (see stage-runtime.ts).
      assertDaemonSupportsPorts(def.name);
      const identity = readRunIdentity(def.name);
      if (!identity) {
        throw new Error(`stage "${def.name}" declares ports and can only run inside a workflow run (no run identity in the environment)`);
      }
      const runtime = createStageRuntime(def, identity, ctx, {
        writtenSinceMs: Number(process.env.LOCALJOBS_RUN_QUEUED_MS) || Date.now(),
      });
      if (fault !== 'skip-outputs') await def.run(runtime.ctx);
      runtime.finalize();
    } else if (fault !== 'skip-outputs') {
      await def.run(ctx);
    }
    emitResultAndExit({ type: 'result', status: 'success' }, 0);
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    emitResultAndExit({ type: 'result', status: 'failed', error: message }, 1);
  }
}
