// A host for engine tests: fixture jobs in, notifications captured.
//
// Importing this module installs it (replacing whatever host was configured), so
// an engine test runs against ONLY the stages it defines: no workflow of the real
// application is loaded, looked up, or notified about. Push a JobDefinition onto
// `jobs` to make it known to the engine.
import { configureEngine } from '../host.js';
import type { JobDefinition, WorkflowRunStatus } from '../types.js';

/** The jobs the engine can look up. Tests push fixture definitions here. */
export const jobs: JobDefinition[] = [];

/** Every "run settled" notification the engine handed to the host, in order. */
export const notifications: { workflow: string; workflowRunId: string; status: WorkflowRunStatus }[] = [];

export function installFixtureHost(): void {
  configureEngine({
    getJob: (name) => jobs.find((j) => j.name === name),
    notify: async ({ workflow, workflowRunId, status, log }) => {
      notifications.push({ workflow: workflow.name, workflowRunId, status });
      log(`notification handed to host — ${workflow.name}: ${status}`);
    },
  });
}

installFixtureHost();
