/**
 * Child process entrypoint. Spawned by the executor as:
 *   node --import tsx src/runJob.ts <jobName>
 *
 * Runs the job in isolation and streams run-state events (log / progress /
 * result) as NDJSON on stdout, which the daemon records. The job's own WORK is
 * written by this process directly: ledger rows (`markWorkItem`), the artifacts a
 * ports stage commits, and the service meters. The body lives in
 * `src/core/child-main.ts`; this file only supplies the registry lookup.
 */
import 'dotenv/config'; // load .env so jobs can read secrets (e.g. API keys)
import { getJobDefinition } from './workflows/registry.js';
import { runJobProcess } from './core/child-main.js';

runJobProcess(process.argv[2], getJobDefinition);
