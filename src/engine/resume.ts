// Resuming a run from where it failed.
//
// A run that fails at its fourth stage has usually done real work in the first
// three: fetched a library, made eight LLM calls, written files that passed their
// checks. Re-running the whole workflow throws that away. A RESUME is a new run
// that reuses what the earlier run's stages committed, wherever that is still
// safe, and runs only the rest.
//
// A stage of the earlier run is reused only when ALL of these hold:
//   - it succeeded there (its latest attempt), or was a noop;
//   - every stage it depends on is being reused too. If something upstream is
//     re-run, its data may differ, so everything downstream re-runs;
//   - it committed every output it declares, each passed its check, and each is
//     still exactly what is on disk (same content fingerprint). A file another
//     run has since rewritten is not reused.
//
// Anything else runs normally. So a resume can never be handed data the engine
// could not vouch for in an ordinary run: the reused artifacts are re-recorded
// under the new run and resolved by its downstream stages like any other input.
import { existsSync, statSync } from 'node:fs';
import { artifactsForRun, fromStoredPath, listRunsForWorkflowRun, type RunArtifactRow } from '../db/store.js';
import type { Dag } from './dag.js';
import { dirStats, sha256File } from './hash.js';
import type { JobDefinition } from './types.js';

export interface ReusableStage {
  /** The stage attempt in the earlier run whose result is reused. */
  priorRunId: string;
  /** What it committed there, one row per output port. */
  artifacts: RunArtifactRow[];
}

export interface ResumePlan {
  reusable: Map<string, ReusableStage>;
  /** For each stage that will run again: why its earlier result is not reused. */
  rerun: Map<string, string>;
}

/** Whether a recorded artifact is still exactly what is on disk. */
function stillIntact(a: RunArtifactRow, def: JobDefinition): string | null {
  if (a.storage === 'inline' || a.storage === 'ledger') return null;
  const path = fromStoredPath(a.path ?? '');
  if (!path || !existsSync(path)) return `${path || '(no path)'} no longer exists`;
  if (a.storage === 'dir') {
    return dirStats(path, def.outputs?.[a.port]?.artifact.files).sha256 === a.sha256 ? null : `${path} has changed since that run`;
  }
  const st = statSync(path);
  const untouched = st.size === a.bytes && Math.floor(st.mtimeMs) === a.mtime_ms;
  return untouched || sha256File(path) === a.sha256 ? null : `${path} has changed since that run`;
}

/**
 * Decide, stage by stage in dependency order, what a resume of `priorWorkflowRunId`
 * can reuse. Pure with respect to the database (reads only) and the filesystem.
 */
export function planResume(dag: Dag, priorWorkflowRunId: string, getJob: (name: string) => JobDefinition | undefined): ResumePlan {
  const reusable = new Map<string, ReusableStage>();
  const rerun = new Map<string, string>();
  // The latest attempt of each stage in the earlier run (rows come back oldest first).
  const latest = new Map<string, { id: string; status: string; outcome_reason?: string | null }>();
  for (const r of listRunsForWorkflowRun(priorWorkflowRunId)) latest.set(r.job_name, r);

  // Dependency order, so a stage is judged after everything it depends on.
  for (const job of dag.waves.flat()) {
    const def = getJob(job);
    const prior = latest.get(job);
    const deps = [...(dag.dependencies.get(job) ?? [])];
    const why = (() => {
      if (!def) return 'it has no definition';
      if (!prior) return 'it never started in that run';
      const ok = prior.status === 'success' || (prior.status === 'skipped' && prior.outcome_reason === 'noop');
      if (!ok) return `it did not succeed in that run (${prior.status}${prior.outcome_reason ? `, ${prior.outcome_reason}` : ''})`;
      const upstream = deps.find((d) => !reusable.has(d));
      if (upstream) return `"${upstream}", which it depends on, is being run again`;
      const artifacts = artifactsForRun(prior.id);
      for (const port of Object.keys(def.outputs ?? {})) {
        const a = artifacts.find((x) => x.port === port);
        if (!a) return `it recorded no "${port}" output in that run`;
        if (a.ok !== 1) return `its "${port}" output failed its check in that run`;
        const problem = stillIntact(a, def);
        if (problem) return `its "${port}" output cannot be reused: ${problem}`;
      }
      reusable.set(job, { priorRunId: prior.id, artifacts: artifacts.filter((a) => def.outputs?.[a.port]) });
      return null;
    })();
    if (why) rerun.set(job, why);
  }
  return { reusable, rerun };
}
