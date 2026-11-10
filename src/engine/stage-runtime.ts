// The child-process half of ports: builds the context a stage runs with, hands
// it its resolved inputs, records the outputs it commits, and at the end makes
// sure every declared output really was committed this run.
//
// Runs INSIDE the stage's own process (see `src/runJob.ts`). The daemon-side half
// (resolving inputs before the stage is spawned, verifying outputs after it
// exits) lives in `workflow-executor.ts` / `executor.ts`.
import { existsSync, statSync } from 'node:fs';
import {
  fromStoredPath,
  previousArtifactSha,
  recordRunArtifact,
  resolvedInputsForStage,
  setRunInputUsed,
  toStoredPath,
} from '../db/store.js';
import { db } from '../db/index.js';
import { writeJsonFile } from './fsjson.js';
import { dirStats, sha256File, sha256Text } from './hash.js';
import { outputLocation } from './ports.js';
import type { ArtifactMeta, ArtifactType, InputHandle, IoItem, OutputHandle, OutputPort, RunIdentity, StageContext } from './ports.js';
import { PORTS_MIN_PROTOCOL } from './protocol.js';
import type { GateResult, JobContext, JobDefinition } from './types.js';

/** How many of an artifact's items are stored with its record as a sample. */
const SUMMARY_SAMPLE = 50;
/** How many `used()` items are kept per input. */
const USED_MAX = 200;

/** Thrown when a stage's output does not pass its own check, or was never written. */
export class StageOutputError extends Error {}

/** The run identity the daemon passed to this child, or null outside a workflow run. */
export function readRunIdentity(jobName: string, env: NodeJS.ProcessEnv = process.env): RunIdentity | null {
  if (!env.LOCALJOBS_WORKFLOW_RUN_ID || !env.LOCALJOBS_RUN_ID) return null;
  return {
    runId: env.LOCALJOBS_RUN_ID,
    workflowRunId: env.LOCALJOBS_WORKFLOW_RUN_ID,
    workflowName: env.LOCALJOBS_WORKFLOW_NAME ?? '',
    jobName,
    attempt: Number(env.LOCALJOBS_RUN_ATTEMPT) || 1,
    cycle: Number(env.LOCALJOBS_RUN_CYCLE) || 1,
    trigger: env.LOCALJOBS_RUN_TRIGGER ?? 'manual',
  };
}

/**
 * Refuse to run a ports stage under a daemon too old to support it. The daemon
 * resolves a stage's inputs before spawning it; one started before ports existed
 * would spawn the stage with nothing resolved, and the stage would fail in a far
 * more confusing way than this.
 */
export function assertDaemonSupportsPorts(jobName: string, env: NodeJS.ProcessEnv = process.env): void {
  const daemon = Number(env.LOCALJOBS_ENGINE) || 0;
  if (daemon < PORTS_MIN_PROTOCOL) {
    throw new Error(
      `stage "${jobName}" declares ports, which need engine protocol ${PORTS_MIN_PROTOCOL}, but the running daemon speaks ` +
        `${daemon || 'an older one'}: the daemon is running older code than this checkout. Restart it (scripts/safe-restart.sh).`,
    );
  }
}

function safeCheck<T>(artifact: ArtifactType<T>, load: () => T): { value?: T; result: GateResult } {
  let value: T;
  try {
    value = load();
  } catch (e) {
    return { result: { ok: false, violations: [`could not be read: ${e instanceof Error ? e.message : String(e)}`] } };
  }
  try {
    return { value, result: artifact.check(value) };
  } catch (e) {
    return { value, result: { ok: false, violations: [`check threw: ${e instanceof Error ? e.message : String(e)}`] } };
  }
}

function violationsOf(r: GateResult): string {
  return r.violations?.length ? r.violations.join('; ') : 'check not satisfied';
}

/** When a file-backed artifact was last written, or null when it does not exist. */
function lastWrittenMs(artifact: ArtifactType, location: string): number | null {
  if (!location || !existsSync(location)) return null;
  if (artifact.storage !== 'dir') return statSync(location).mtimeMs;
  const stats = dirStats(location, artifact.files);
  // A shared directory holding none of this artifact's files yet: exists, never written.
  return artifact.files && stats.files === 0 ? statSync(location).birthtimeMs : stats.mtimeMs;
}

export interface StageRuntime {
  ctx: StageContext;
  /**
   * End-of-run sweep. Every declared output must have been committed:
   *  - one the stage wrote but did not commit is committed here (so most stages
   *    never call `commit()`);
   *  - a `cumulative` one that was not touched is recorded as carried forward;
   *  - anything else fails the stage, naming the output.
   */
  finalize(): void;
}

export interface StageRuntimeOptions {
  /**
   * "Written this run" means written at or after this instant: when the stage
   * became ready in this cycle. (Not this attempt's own start, so that a retry
   * still counts what an earlier attempt of the same stage wrote.)
   */
  writtenSinceMs?: number;
}

/**
 * Build the context for one attempt of a ports stage. `base` supplies log /
 * progress / the run-limit helpers; this adds `run`, `input`, `inputs`, `output`.
 */
export function createStageRuntime(
  def: JobDefinition,
  identity: RunIdentity,
  base: JobContext,
  opts: StageRuntimeOptions = {},
): StageRuntime {
  const writtenSinceMs = opts.writtenSinceMs ?? Date.now();
  const inputPorts = def.inputs ?? {};
  const outputPorts = def.outputs ?? {};
  const committed = new Set<string>();

  // ── inputs: what the daemon resolved for this stage before spawning it ──
  let resolved: ReturnType<typeof resolvedInputsForStage> | null = null;
  const handlesFor = (port: string): InputHandle[] => {
    const decl = inputPorts[port];
    if (!decl) throw new Error(`stage "${def.name}" has no input port "${port}" (declared: ${Object.keys(inputPorts).join(', ') || 'none'})`);
    resolved ??= resolvedInputsForStage(identity.workflowRunId, def.name, identity.cycle);
    const rows = resolved.filter((r) => r.port === port && r.ok === 1 && r.artifact);
    if (rows.length === 0) {
      throw new Error(
        `stage "${def.name}" input "${port}" (artifact "${decl.artifact.key}") was not resolved for this run. ` +
          `The engine resolves inputs before a stage starts; a stage run outside the workflow engine has none.`,
      );
    }
    return rows.map((r) => {
      const a = r.artifact!;
      const location = a.storage === 'inline' ? '' : a.storage === 'ledger' ? (a.path ?? r.producer_job) : fromStoredPath(a.path ?? '');
      const meta: ArtifactMeta = {
        id: a.id,
        producer: r.producer_job,
        runId: a.run_id,
        sha256: a.sha256,
        bytes: a.bytes,
        itemCount: a.item_count,
        fresh: a.fresh === 1,
        committedAtMs: a.created_at_ms,
      };
      return {
        from: r.producer_job,
        location,
        path: location,
        meta,
        read: () => decl.artifact.read(a.storage === 'inline' ? (a.inline_json ?? 'null') : location),
        used: (items: IoItem[]) =>
          setRunInputUsed(identity.workflowRunId, identity.cycle, def.name, port, r.producer_job, {
            total: items.length,
            items: items.slice(0, USED_MAX),
          }),
      };
    });
  };

  // ── outputs ──
  const record = (
    port: string,
    out: OutputPort,
    location: string,
    result: GateResult,
    value: unknown,
    extra: { carried?: boolean; note?: string; inlineJson?: string },
  ): void => {
    const { artifact } = out;
    let sha256: string | null = null;
    let bytes: number | null = null;
    let mtimeMs: number | null = null;
    if (artifact.storage === 'inline') {
      sha256 = sha256Text(extra.inlineJson ?? 'null');
      bytes = (extra.inlineJson ?? '').length;
    } else if (artifact.storage === 'dir' && existsSync(location)) {
      const s = dirStats(location, artifact.files);
      ({ sha256, bytes, mtimeMs } = s);
    } else if ((artifact.storage === 'json' || artifact.storage === 'file') && existsSync(location)) {
      const st = statSync(location);
      bytes = st.size;
      mtimeMs = st.mtimeMs;
      sha256 = sha256File(location);
    }

    let itemCount: number | null = null;
    let summary: { summary?: string; items?: IoItem[] } | undefined;
    if (value !== undefined && result.ok) {
      // Display metadata is best-effort: a throwing summary must not fail a stage
      // whose data passed its check.
      try {
        const items = artifact.items?.(value as never);
        itemCount = artifact.count ? artifact.count(value as never) : (items ? items.length : null);
        summary = { summary: artifact.summary?.(value as never) ?? result.sample, items: items?.slice(0, SUMMARY_SAMPLE) };
      } catch (e) {
        base.log(`output "${port}": could not build its display summary (${e instanceof Error ? e.message : e})`, 'warn');
      }
    }

    // "Fresh" = this commit changed the content. A carried-forward artifact never
    // is; a written one is unless it came out byte-identical to the last commit.
    // A ledger artifact has no file to hash: it is fresh when this attempt changed
    // a row of that ledger.
    let fresh: boolean;
    if (extra.carried) fresh = false;
    else if (artifact.storage === 'ledger') {
      // (A `skipped` row is a soft stop, not new content.)
      fresh = !!db.prepare(
        "SELECT 1 FROM work_item_runs WHERE run_id = ? AND job_name = ? AND changed = 1 AND COALESCE(status, '') <> 'skipped' LIMIT 1",
      ).get(identity.runId, location);
    } else {
      const prev = previousArtifactSha(def.name, port, identity.runId);
      fresh = prev === null || prev !== sha256;
    }

    recordRunArtifact({
      workflowRunId: identity.workflowRunId,
      runId: identity.runId,
      cycle: identity.cycle,
      jobName: def.name,
      port,
      artifactKey: artifact.key,
      storage: artifact.storage,
      path: artifact.storage === 'inline' ? null : artifact.storage === 'ledger' ? location : toStoredPath(location),
      sha256,
      bytes,
      mtimeMs,
      itemCount,
      fresh,
      ok: result.ok,
      check: result,
      summary,
      inlineJson: extra.inlineJson ?? null,
      note: extra.note ?? null,
    });
    committed.add(port);
  };

  const outputHandle = (port: string): OutputHandle => {
    const out = outputPorts[port];
    if (!out) throw new Error(`stage "${def.name}" has no output port "${port}" (declared: ${Object.keys(outputPorts).join(', ') || 'none'})`);
    const { artifact } = out;
    const location = outputLocation(def.name, out);

    const commitFromLocation = (extra: { carried?: boolean; note?: string }): void => {
      if (artifact.storage === 'inline') {
        throw new StageOutputError(`output "${port}" of "${def.name}" is an inline value: give it with write(value)`);
      }
      const { value, result } = safeCheck(artifact, () => artifact.read(location));
      record(port, out, location, result, value, extra);
      if (!result.ok) {
        throw new StageOutputError(`output "${port}" (${artifact.key}) of "${def.name}" failed its check: ${violationsOf(result)}`);
      }
      const what = result.sample ?? result.detail;
      base.log(`⤴ output "${port}" (${artifact.key}) ${extra.carried ? 'carried forward unchanged' : 'committed'}${what ? ` — ${what}` : ''}${extra.note ? ` (${extra.note})` : ''}`);
    };

    return {
      location,
      path: location,
      write(value) {
        if (artifact.storage !== 'json' && artifact.storage !== 'inline') {
          throw new StageOutputError(
            `output "${port}" of "${def.name}" is a ${artifact.storage} artifact: write its data yourself, then commit() it`,
          );
        }
        // Check BEFORE anything is written: a value that fails never reaches disk.
        const { result } = safeCheck(artifact, () => value);
        if (!result.ok) {
          record(port, out, location, result, undefined, {});
          committed.delete(port);
          throw new StageOutputError(`output "${port}" (${artifact.key}) of "${def.name}" failed its check, nothing was written: ${violationsOf(result)}`);
        }
        if (artifact.storage === 'inline') {
          record(port, out, location, result, value, { inlineJson: JSON.stringify(value ?? null) });
        } else {
          writeJsonFile(location, value); // atomic
          record(port, out, location, result, value, {});
        }
        const what = result.sample ?? result.detail;
        base.log(`⤴ output "${port}" (${artifact.key}) written${what ? ` — ${what}` : ''}`);
      },
      commit: () => commitFromLocation({}),
      unchanged: (reason) => commitFromLocation({ carried: true, note: reason }),
    };
  };

  const ctx: StageContext = {
    ...base,
    run: identity,
    input: (port: string) => {
      if (inputPorts[port]?.many) throw new Error(`stage "${def.name}" input "${port}" is a fan-in (many): read it with ctx.inputs("${port}")`);
      return handlesFor(port)[0];
    },
    inputs: (port: string) => handlesFor(port),
    output: (port: string) => outputHandle(port),
  } as StageContext;

  return {
    ctx,
    finalize() {
      for (const [port, out] of Object.entries(outputPorts)) {
        if (committed.has(port)) continue;
        const { artifact } = out;
        const handle = outputHandle(port);
        if (artifact.storage === 'inline') {
          throw new StageOutputError(
            `stage "${def.name}" finished without writing its declared output "${port}" (${artifact.key}). ` +
              `Every declared output must be committed on every run: call ctx.output("${port}").write(value).`,
          );
        }
        if (artifact.storage === 'ledger') {
          handle.commit(); // the rows are already in the ledger; this checks and records them
          continue;
        }
        const written = lastWrittenMs(artifact, handle.location);
        if (written !== null && written >= writtenSinceMs - 1) {
          handle.commit();
        } else if (out.cumulative && written !== null) {
          handle.unchanged('nothing new to add this run');
        } else {
          throw new StageOutputError(
            `stage "${def.name}" finished without writing its declared output "${port}" (${artifact.key}) this run: ` +
              (written === null ? `${handle.location} does not exist` : `${handle.location} was last written before this stage started`) +
              `. A stage that returns success must commit every declared output. If leaving the previous one in place ` +
              `is correct this run, say so with ctx.output("${port}").unchanged(reason).`,
          );
        }
      }
    },
  };
}
