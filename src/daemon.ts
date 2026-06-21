/**
 * The orchestrator daemon. This is the single long-lived process kept alive by
 * launchd. It syncs job definitions into the DB, reaps orphaned runs from any
 * prior crash, starts the scheduler, and serves the control/read API.
 */
import 'dotenv/config'; // load .env for config (ports, paths) and jobs
import { config } from './config.js';
import { startApi } from './api/server.js';
import { startScheduler, stopScheduler } from './core/scheduler.js';
import { jobs, pipelines, services } from './jobs/registry.js';
import { reapOrphanPipelineRuns, reapOrphanRuns, syncJob, syncPipeline, syncService } from './db/store.js';

function main(): void {
  console.log('[daemon] starting local-jobs orchestrator');
  console.log(`[daemon] db: ${config.dbPath}`);

  // Sync code-defined jobs, services, and pipelines into the DB (preserves user `enabled` toggles).
  for (const def of jobs) syncJob(def);
  for (const def of services) syncService(def);
  for (const def of pipelines) syncPipeline(def);
  console.log(`[daemon] synced ${jobs.length} job(s), ${services.length} service(s), ${pipelines.length} pipeline(s)`);
  if (pipelines.length) console.log(`[daemon] pipelines: ${pipelines.map((p) => p.name).join(', ')}`);

  const reaped = reapOrphanRuns() + reapOrphanPipelineRuns();
  if (reaped > 0) console.log(`[daemon] reaped ${reaped} orphaned run(s) from a previous crash`);

  startScheduler();
  startApi();

  const shutdown = (signal: string) => {
    console.log(`[daemon] ${signal} received — shutting down`);
    stopScheduler();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  console.log('[daemon] up');
}

main();
