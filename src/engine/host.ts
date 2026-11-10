// The engine's connection to the application it runs inside.
//
// The engine knows how to run a DAG of stages. It does NOT know which jobs exist,
// or what should happen when a run finishes: those belong to the host. The host
// hands them in here once, at startup. This is what keeps the engine isolated: no
// file under `src/engine/` imports a workflow, a service, the registry or the
// notifier, and the engine can be driven end to end in a test with fixture stages
// and nothing else loaded.
import type { JobDefinition, LogLevel, WorkflowDefinition, WorkflowRunStatus } from './types.js';

export interface EngineHost {
  /** Look a job up by name. The engine never enumerates jobs; it only asks for the ones a workflow names. */
  getJob(name: string): JobDefinition | undefined;
  /**
   * Called once when a workflow run settles and notifications are enabled for
   * that workflow. `log` writes to the run's framework log (so "notification
   * sent / failed" is recorded with the run). Optional: a host with nothing to
   * notify (a test) leaves it out.
   */
  notify?(event: {
    workflow: WorkflowDefinition;
    workflowRunId: string;
    status: WorkflowRunStatus;
    log: (message: string, level?: LogLevel) => void;
  }): Promise<void>;
}

let host: EngineHost = { getJob: () => undefined };

/** Install the host. Call once at startup (the registry does); tests call it with fixtures. */
export function configureEngine(next: EngineHost): void {
  host = next;
}

/** The current host. */
export function engineHost(): EngineHost {
  return host;
}

/** Look a job up through the host. */
export function getJob(name: string): JobDefinition | undefined {
  return host.getJob(name);
}
