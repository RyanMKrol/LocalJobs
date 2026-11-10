// The daemon-side half of ports: before a stage is spawned, resolve each of its
// inputs to the artifact its producer committed IN THIS WORKFLOW RUN, and make
// sure that artifact is still what is on disk. This is the gate.
//
// It replaces "a file exists at this path and looks right" (which a stale file
// from last week satisfies) with "the upstream stage of THIS run vouched for
// this exact content, and nothing has touched it since".
import { existsSync, statSync } from 'node:fs';
import { artifactsForRun, fromStoredPath, producedArtifact, type RunArtifactRow } from '../db/store.js';
import { dirStats, sha256File } from './hash.js';
import type { PortBinding } from './ports.js';
import type { JobDefinition } from './types.js';

export interface ResolvedInput {
  ok: boolean;
  /** Why it could not be resolved, in a sentence a person can act on. */
  reason?: string;
  artifact?: RunArtifactRow;
}

/** A short "what is this" for the log line of a resolved input. */
export function describeArtifact(a: RunArtifactRow): string {
  let summary: string | undefined;
  try {
    summary = a.summary_json ? (JSON.parse(a.summary_json) as { summary?: string }).summary : undefined;
  } catch { /* an unreadable summary is not worth failing over */ }
  const bits = [
    summary,
    a.item_count != null && !summary ? `${a.item_count} item(s)` : undefined,
    // Not fresh means one of two things, and the run page tells them apart the same
    // way: left alone this run (it has a note saying why), or written again with
    // exactly the content it already had.
    a.fresh ? undefined : a.note ? 'carried forward unchanged' : 'written again, same as before',
  ].filter(Boolean);
  return bits.join(' · ');
}

/**
 * Resolve one input binding for one cycle of a workflow run.
 *
 * Fails when the producer committed nothing for that artifact in this run, when
 * what it committed failed its own check, or when the file or directory has
 * changed since it was committed (some other process wrote it in between).
 */
export function resolveInput(
  workflowRunId: string,
  cycle: number,
  b: PortBinding,
  /** For a directory artifact that shares its directory: which files are its own (`ArtifactType.files`). */
  belongs?: (name: string) => boolean,
): ResolvedInput {
  const a = producedArtifact(workflowRunId, cycle, b.producer, b.artifactKey);
  if (!a) {
    return {
      ok: false,
      reason:
        `"${b.producer}" succeeded but committed no "${b.artifactKey}" artifact in this run ` +
        `(a file from an earlier run is never accepted in its place)`,
    };
  }
  if (a.ok !== 1) return { ok: false, artifact: a, reason: `the "${b.artifactKey}" artifact "${b.producer}" committed failed its own check` };

  if (a.storage === 'json' || a.storage === 'file' || a.storage === 'dir') {
    const path = fromStoredPath(a.path ?? '');
    if (!existsSync(path)) {
      return { ok: false, artifact: a, reason: `${path} no longer exists (it did when "${b.producer}" committed it)` };
    }
    const changed = (): ResolvedInput => ({
      ok: false,
      artifact: a,
      reason: `${path} has changed since "${b.producer}" committed it: something else wrote it between the two stages`,
    });
    if (a.storage === 'dir') {
      if (dirStats(path, belongs).sha256 !== a.sha256) return changed();
    } else {
      const st = statSync(path);
      // Same size and mtime as recorded: unchanged. Otherwise only the content
      // hash decides (a rewrite of identical bytes is not a change).
      const untouched = st.size === a.bytes && Math.floor(st.mtimeMs) === a.mtime_ms;
      if (!untouched && sha256File(path) !== a.sha256) return changed();
    }
  }
  return { ok: true, artifact: a };
}

/**
 * Declared output ports that have no committed artifact for this attempt. A
 * ports stage commits every output before it exits, so this is non-empty only
 * when the stage's process and the daemon disagree about what the stage is
 * (different code versions), or the record could not be written.
 */
export function uncommittedOutputs(runId: string, def: Pick<JobDefinition, 'outputs'>): string[] {
  const ports = Object.keys(def.outputs ?? {});
  if (ports.length === 0) return [];
  const done = new Set(artifactsForRun(runId).filter((a) => a.ok === 1).map((a) => a.port));
  return ports.filter((p) => !done.has(p));
}
