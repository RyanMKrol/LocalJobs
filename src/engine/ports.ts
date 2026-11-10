// Ports: the contract between the stages of a workflow.
//
// A stage declares named INPUTS and OUTPUTS. Each port carries an ArtifactType,
// which says what the data is, where it lives, how to check it and how to show
// it. The engine does the rest:
//
//   - at load, it BINDS every input to the upstream stage(s) that output the same
//     artifact, and refuses to start if anything does not line up
//   - before a stage runs, it RESOLVES each input to what the producer committed
//     in THIS workflow run (never "whatever file is on disk") and hands it in
//   - when a stage finishes, it checks that every declared output was committed
//     this run, and records it
//   - the run page's Inputs & Outputs are simply those records
//
// This file is the pure, declarative half: types, constructors, binding and
// validation. Nothing here touches the database or runs a stage. The runtime half
// is `stage-runtime.ts` (child side) and `workflow-executor.ts` (daemon side).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonFile } from './fsjson.js';
import { buildDag } from './dag.js';
import type { Gate } from './dag.js';
import type { ArtifactShape, ExpectationResult, GateResult, JobContext, JobDefinition, WorkflowDefinition } from './types.js';

// ───────────────────────────── display rows ─────────────────────────────

/**
 * One row in a stage's Inputs or Outputs list. This is an EXPLICIT display
 * schema: the stage (or its artifact type) says what the title is and which
 * fields matter. The dashboard used to guess, showing the first four scalar keys
 * of a ledger row's `detail` in insertion order.
 */
export interface IoItem {
  /** Stable id within its list (an item key, a file name, an index). */
  id: string;
  /** What a person would call this item. */
  title: string;
  subtitle?: string;
  /** Optional per-item status shown as a badge (success / failed / skipped …). */
  status?: string;
  /** Labelled facts worth showing at a glance. */
  fields?: { label: string; value: string }[];
  /** A file to preview on click, with the renderer to use. */
  preview?: { path: string; format: string };
}

// ───────────────────────────── artifact types ─────────────────────────────

/** Where an artifact's data lives. */
export type ArtifactStorage =
  | 'json' //   one JSON file
  | 'file' //   one file of any other kind (markdown, text, …)
  | 'dir' //    a directory of per-item files
  | 'ledger' // rows of the work_items ledger (the data itself travels there)
  | 'inline'; // a small value kept in the run record (no file at all)

/** What a `dir` artifact's value looks like to its check. */
export interface DirListing {
  path: string;
  /** Regular files directly inside the directory (names only, sorted). */
  files: string[];
}

/** What a `file` artifact's value looks like to its check. */
export interface FileInfo {
  path: string;
  bytes: number;
  /** The file's text, read lazily (large files are not loaded unless asked for). */
  text(): string;
}

/** One ledger row, as a `ledger` artifact's check sees it. */
export interface LedgerRowValue {
  itemKey: string;
  status: string;
  detail: unknown;
}

/**
 * A kind of data one stage hands to another. `key` is what a consumer binds to:
 * an input whose artifact has key K is fed by the upstream stage that outputs K.
 *
 * `check` receives the VALUE (already loaded), not a path it must go and find, so
 * the same check validates what a producer is about to commit and what a consumer
 * is about to read. It should be quick and side-effect free.
 */
export interface ArtifactType<T = unknown> {
  key: string;
  /** One plain sentence: what this is. Shown on the gate and stage pages. */
  description: string;
  storage: ArtifactStorage;
  /** Renderer for previews: 'json' | 'markdown' | 'text' | a custom format. */
  format?: string;
  /** The expected shape, in plain words, for the gate page. */
  shape?: ArtifactShape;
  /** Load the value from its location (a path, or a ledger job name). */
  read(location: string): T;
  check(value: T): GateResult;
  /** A short human summary, e.g. "650 shows, 612 with a TMDB id". */
  summary?(value: T): string;
  /** How many items the artifact holds. Defaults to `items(value).length`. */
  count?(value: T): number;
  /** The artifact's contents as display rows (may be large; the caller pages). */
  items?(value: T): IoItem[];
  /**
   * `dir` storage only: which files in the directory belong to this artifact.
   * Without it every regular file directly inside does. Give it when the
   * directory is shared (a reports folder that also holds a data file another
   * stage rewrites): otherwise that other file would make this artifact look
   * changed, or would fail a consumer's "has anything touched it since" check.
   */
  files?(name: string): boolean;
}

type ArtifactOptions<T> = Pick<ArtifactType<T>, 'key' | 'description' | 'shape' | 'format' | 'check' | 'summary' | 'count' | 'items' | 'files'>;

/** Build a GateResult from per-expectation checks (the shape the gate page renders). */
export function fromChecks(checks: ExpectationResult[], sample?: string): GateResult {
  const failed = checks.filter((c) => !c.ok);
  const ok = failed.length === 0;
  return {
    ok,
    violations: ok ? undefined : failed.map((c) => `${c.label}: ${c.actual ?? 'failed'}`),
    checks,
    sample,
    detail: sample,
  };
}

/** A check that accepts anything. For outputs whose mere existence is the contract. */
export const acceptAny = (): GateResult => ({ ok: true });

/** One JSON file. `read` throws (naming the file) when it is missing or not valid JSON. */
export function jsonArtifact<T>(o: ArtifactOptions<T>): ArtifactType<T> {
  return {
    format: 'json',
    ...o,
    storage: 'json',
    read(path) {
      if (!existsSync(path)) throw new Error(`${path} does not exist`);
      return readJsonFile<T>(path, undefined as T);
    },
  };
}

/** One non-JSON file (markdown, text, …). The check sees its path, size and (lazily) its text. */
export function fileArtifact(o: ArtifactOptions<FileInfo>): ArtifactType<FileInfo> {
  return {
    format: 'text',
    ...o,
    storage: 'file',
    read(path) {
      const st = statSync(path); // throws ENOENT with the path when missing
      if (!st.isFile()) throw new Error(`${path} is not a file`);
      return { path, bytes: st.size, text: () => readFileSync(path, 'utf8') };
    },
  };
}

/** A directory of per-item files. The check sees the file names directly inside it. */
export function dirArtifact(o: ArtifactOptions<DirListing>): ArtifactType<DirListing> {
  return {
    ...o,
    storage: 'dir',
    read(path) {
      if (!existsSync(path)) throw new Error(`${path} does not exist`);
      const files = readdirSync(path, { withFileTypes: true })
        .filter((e) => e.isFile() && (!o.files || o.files(e.name)))
        .map((e) => e.name)
        .sort();
      return { path, files };
    },
  };
}

/**
 * Rows of the work_items ledger, for pipelines where the ledger itself carries
 * the data between stages. The location is the ledger job name. The reader is
 * injected (the store), keeping this module free of database imports.
 */
export function ledgerArtifact(
  o: ArtifactOptions<LedgerRowValue[]> & { readRows: (ledgerJob: string) => LedgerRowValue[] },
): ArtifactType<LedgerRowValue[]> {
  const { readRows, ...rest } = o;
  return {
    ...rest,
    storage: 'ledger',
    read: (ledgerJob) => readRows(ledgerJob),
    count: rest.count ?? ((rows) => rows.length),
  };
}

/** A small value kept in the run record itself (a count, a digest, a verdict). */
export function inlineArtifact<T>(o: ArtifactOptions<T>): ArtifactType<T> {
  return {
    format: 'json',
    ...o,
    storage: 'inline',
    read: (json) => JSON.parse(json) as T,
  };
}

// ───────────────────────────── ports ─────────────────────────────

export interface OutputPort<T = unknown> {
  artifact: ArtifactType<T>;
  /**
   * Where the artifact lives: a file or directory path (json / file / dir), or
   * the ledger job name (ledger; defaults to the stage's own name). Not used for
   * inline. A function is evaluated at run time, so it can read config.
   */
  location?: string | (() => string);
  /**
   * A CUMULATIVE store: a file or directory the stage adds to over many runs
   * (resolved ids, fetched pages, a history), as opposed to an artifact built
   * afresh each run (a snapshot, a digest). On a run with nothing new to add, a
   * cumulative output that was not touched is recorded as carried forward. A
   * non-cumulative output that was not written this run fails the stage: that is
   * the "succeeded without producing anything, so the next stage used last
   * week's file" bug, and it must be loud.
   */
  cumulative?: boolean;
}

export interface InputPort<T = unknown> {
  artifact: ArtifactType<T>;
  /**
   * A fan-in port: fed by EVERY direct dependency that outputs this artifact
   * (one entry per producer), read with `ctx.inputs(port)`. Without it the port
   * must be fed by exactly one.
   */
  many?: boolean;
  /**
   * Only needed to disambiguate, when more than one direct dependency outputs
   * this artifact and the port should take a subset. Normally omitted: the
   * binding is worked out from the DAG and the artifact key.
   */
  from?: string | string[];
}

/** Persistent state a stage reads or writes ACROSS runs: declared so it is visible, not enforced. */
export interface StateDecl {
  kind: 'file' | 'ledger';
  /** A short name for it, e.g. "recs-history". */
  name: string;
  access: 'read' | 'write' | 'readwrite';
  /** One sentence: what it is and who else touches it. */
  note: string;
  /** For kind 'file': where it lives. */
  path?: () => string;
}

// ───────────────────────────── stage context ─────────────────────────────

/** Identity of the run a stage is executing in. */
export interface RunIdentity {
  /** This attempt's own run id (the `runs` row). */
  runId: string;
  workflowRunId: string;
  workflowName: string;
  jobName: string;
  attempt: number;
  /** repeatUntilStable cycle, 1-based. */
  cycle: number;
  /** What started the workflow run. */
  trigger: string;
}

/** What is recorded about a committed artifact. */
export interface ArtifactMeta {
  /** `run_artifacts.id`. */
  id: number;
  producer: string;
  /** The producing attempt's run id. */
  runId: string;
  sha256: string | null;
  bytes: number | null;
  itemCount: number | null;
  /** False when the producer carried the previous artifact forward unchanged. */
  fresh: boolean;
  committedAtMs: number;
}

/** An input, as handed to a stage. */
export interface InputHandle<T = unknown> {
  /** The stage that produced it. */
  from: string;
  /** File or directory path (json / file / dir), or ledger job name (ledger). Empty for inline. */
  location: string;
  /** Alias of `location` for file-backed artifacts. */
  path: string;
  meta: ArtifactMeta;
  /** Load and return the value. */
  read(): T;
  /**
   * Optional: report which items of this input the stage actually USED, when that
   * is a subset worth showing (a prompt that sampled 40 of 650 shows). The run
   * page then lists these as the stage's inputs instead of the whole artifact.
   */
  used(items: IoItem[]): void;
}

/** An output, as a stage commits it. */
export interface OutputHandle<T = unknown> {
  /** Where the artifact lives (resolved from the port's `location`). Empty for inline. */
  location: string;
  /** Alias of `location` for file-backed artifacts. */
  path: string;
  /**
   * Check `value`, write it atomically (json) or store it (inline), and record
   * it. Throws, failing the stage, if the check does not pass: nothing is written.
   */
  write(value: T): void;
  /**
   * For data the stage wrote itself (a file it streamed, a directory it filled,
   * ledger rows it marked): load it from its location, check it and record it.
   * Called automatically at the end of the run for any declared output that was
   * written but not committed, so most stages never call it.
   */
  commit(): void;
  /**
   * Say that this run deliberately leaves the artifact as it was (nothing new to
   * add). It is still checked and recorded, marked as carried forward. Without
   * this, a declared output that was not written this run fails the stage.
   */
  unchanged(reason: string): void;
}

type PortMap<P> = Record<string, P>;
type ValueOfInput<P> = P extends InputPort<infer T> ? T : never;
type ValueOfOutput<P> = P extends OutputPort<infer T> ? T : never;

/**
 * The context a ports stage runs with: everything a plain job has (log,
 * progress, the run-limit helpers), plus its run identity and its ports.
 */
export interface StageContext<I extends PortMap<InputPort<any>> = PortMap<InputPort>, O extends PortMap<OutputPort<any>> = PortMap<OutputPort>>
  extends JobContext {
  run: RunIdentity;
  /** The single producer of a non-fan-in input. */
  input<K extends keyof I & string>(port: K): InputHandle<ValueOfInput<I[K]>>;
  /** Every producer of a fan-in (`many`) input, in manifest order. */
  inputs<K extends keyof I & string>(port: K): InputHandle<ValueOfInput<I[K]>>[];
  output<K extends keyof O & string>(port: K): OutputHandle<ValueOfOutput<O[K]>>;
}

/** A stage definition: a job that declares its ports. */
export interface StageDefinition<I extends PortMap<InputPort<any>>, O extends PortMap<OutputPort<any>>>
  extends Omit<JobDefinition, 'run' | 'inputs' | 'outputs' | 'produces' | 'consumes'> {
  inputs?: I;
  outputs?: O;
  run(ctx: StageContext<I, O>): Promise<void>;
}

/**
 * Define a stage. The result is an ordinary JobDefinition the registry discovers;
 * what makes it a ports stage is that `inputs` and `outputs` are present (even
 * when empty), which is how the engine tells it from a legacy job.
 */
export function defineStage<I extends PortMap<InputPort<any>> = {}, O extends PortMap<OutputPort<any>> = {}>(
  def: StageDefinition<I, O>,
): JobDefinition {
  const { run, inputs, outputs, ...rest } = def;
  return {
    ...rest,
    inputs: (inputs ?? {}) as PortMap<InputPort>,
    outputs: (outputs ?? {}) as PortMap<OutputPort>,
    run: (ctx) => {
      if (!isStageContext(ctx)) {
        throw new Error(
          `stage "${def.name}" declares ports and must be run by the workflow engine (or a test context from ` +
            `makeTestContext): the context it was given has no inputs/outputs`,
        );
      }
      return run(ctx as unknown as StageContext<I, O>);
    },
  };
}

function isStageContext(ctx: JobContext): boolean {
  const c = ctx as Partial<StageContext>;
  return typeof c.input === 'function' && typeof c.output === 'function' && !!c.run;
}

/** Whether a job declares ports (was made by `defineStage`). */
export function isPortsJob(def: Pick<JobDefinition, 'inputs' | 'outputs'>): boolean {
  return def.inputs !== undefined || def.outputs !== undefined;
}

/** Resolve an output port's location for a given stage. */
export function outputLocation(jobName: string, port: OutputPort): string {
  if (port.artifact.storage === 'inline') return '';
  if (port.location === undefined) {
    if (port.artifact.storage === 'ledger') return jobName; // a stage's ledger is its own by default
    throw new Error(`output artifact "${port.artifact.key}" of "${jobName}" needs a location (a file or directory path)`);
  }
  return typeof port.location === 'function' ? port.location() : port.location;
}

// ───────────────────────────── binding + validation ─────────────────────────────

/** One resolved connection: `consumer.port` is fed by `producer.producerPort`. */
export interface PortBinding {
  consumer: string;
  port: string;
  producer: string;
  producerPort: string;
  artifactKey: string;
  many: boolean;
}

export type WorkflowMode = 'ports' | 'legacy';

type JobLookup = (name: string) => JobDefinition | undefined;

/**
 * Whether a workflow's stages use ports or the legacy produces/consumes
 * contracts. A workflow is migrated as a whole, so a mix is an error (reported
 * by `validateWorkflowPorts`); this returns 'ports' as soon as any member does.
 */
export function workflowMode(wf: Pick<WorkflowDefinition, 'jobs'>, getJob: JobLookup): WorkflowMode {
  return wf.jobs.some((ref) => {
    const def = getJob(ref.job);
    return def ? isPortsJob(def) : false;
  })
    ? 'ports'
    : 'legacy';
}

/**
 * Work out, for every input port of every stage of a ports workflow, which
 * upstream stage(s) feed it. Returns the bindings plus every problem found; a
 * non-empty `errors` means the workflow must not load.
 *
 * The rules, which are the whole contract:
 *   1. An input binds to DIRECT dependencies only (the manifest's `dependsOn`).
 *      Reading something from further back means adding that edge, so the DAG
 *      drawn on the dashboard is the real data flow.
 *   2. A plain input needs exactly one direct dependency that outputs its
 *      artifact. A `many` input takes every one that does (at least one).
 *   3. Every edge must carry data: each direct dependency must feed at least
 *      one input. An edge with nothing flowing over it is a hidden coupling.
 *   4. A stage outputs each artifact key at most once.
 */
export function bindWorkflowPorts(
  wf: Pick<WorkflowDefinition, 'name' | 'jobs'>,
  getJob: JobLookup,
): { bindings: PortBinding[]; errors: string[] } {
  const errors: string[] = [];
  const bindings: PortBinding[] = [];
  const members = wf.jobs.map((r) => r.job);

  // Mixed mode is an error: every member must declare ports.
  const legacy = members.filter((m) => {
    const d = getJob(m);
    return d && !isPortsJob(d);
  });
  if (legacy.length > 0) {
    errors.push(
      `mixes ports stages with legacy produces/consumes stages (${legacy.join(', ')}); a workflow is migrated as a whole`,
    );
    return { bindings, errors };
  }

  // Rule 4, and an index of who outputs what.
  const outputsByJob = new Map<string, Map<string, string>>(); // job → artifactKey → port
  for (const m of members) {
    const byKey = new Map<string, string>();
    for (const [port, out] of Object.entries(getJob(m)?.outputs ?? {})) {
      const key = out.artifact.key;
      if (byKey.has(key)) errors.push(`"${m}" outputs artifact "${key}" twice (ports "${byKey.get(key)}" and "${port}")`);
      else byKey.set(key, port);
      if (out.artifact.storage !== 'inline' && out.artifact.storage !== 'ledger' && out.location === undefined) {
        errors.push(`"${m}" output "${port}" (${out.artifact.storage} artifact "${key}") has no location`);
      }
    }
    outputsByJob.set(m, byKey);
  }

  for (const ref of wf.jobs) {
    const def = getJob(ref.job);
    if (!def) continue; // unknown members are reported by the registry itself
    const deps = ref.dependsOn ?? [];
    const fed = new Set<string>();

    for (const [port, input] of Object.entries(def.inputs ?? {})) {
      const key = input.artifact.key;
      let candidates = deps.filter((d) => outputsByJob.get(d)?.has(key));
      if (input.from !== undefined) {
        const wanted = Array.isArray(input.from) ? input.from : [input.from];
        for (const w of wanted) {
          if (!deps.includes(w)) errors.push(`"${ref.job}" input "${port}" names "${w}" in \`from\`, which is not one of its dependsOn stages`);
          else if (!outputsByJob.get(w)?.has(key)) errors.push(`"${ref.job}" input "${port}" names "${w}" in \`from\`, which does not output artifact "${key}"`);
        }
        candidates = candidates.filter((c) => wanted.includes(c));
      }
      if (candidates.length === 0) {
        const elsewhere = members.filter((m) => outputsByJob.get(m)?.has(key));
        errors.push(
          `"${ref.job}" input "${port}" needs artifact "${key}", but none of its dependsOn stages ` +
            `(${deps.join(', ') || 'none'}) outputs it` +
            (elsewhere.length ? ` — "${elsewhere.join('", "')}" does: add it to dependsOn in the manifest` : ''),
        );
        continue;
      }
      if (!input.many && candidates.length > 1) {
        errors.push(
          `"${ref.job}" input "${port}" (artifact "${key}") is fed by ${candidates.length} stages (${candidates.join(', ')}): ` +
            `make it a fan-in with \`many: true\`, or pick one with \`from\``,
        );
        continue;
      }
      for (const producer of candidates) {
        fed.add(producer);
        bindings.push({
          consumer: ref.job,
          port,
          producer,
          producerPort: outputsByJob.get(producer)!.get(key)!,
          artifactKey: key,
          many: !!input.many,
        });
      }
    }

    // Rule 3: every edge carries data.
    for (const dep of deps) {
      if (!fed.has(dep)) {
        errors.push(`edge ${dep} → ${ref.job} carries no data: "${ref.job}" declares no input fed by "${dep}" (declare one, or remove the edge)`);
      }
    }
  }
  return { bindings, errors };
}

/**
 * Every problem with a workflow's ports, as readable strings (empty = valid).
 * A legacy workflow is validated by its own rule: every edge needs a matching
 * produces/consumes key. Both are checked at LOAD by the registry, so a broken
 * contract stops the daemon instead of surfacing halfway through a night's run.
 */
export function validateWorkflowContracts(wf: Pick<WorkflowDefinition, 'name' | 'jobs'>, getJob: JobLookup): string[] {
  if (workflowMode(wf, getJob) === 'ports') return bindWorkflowPorts(wf, getJob).errors;
  const errors: string[] = [];
  for (const ref of wf.jobs) {
    const consumes = new Set((getJob(ref.job)?.consumes ?? []).map((c) => c.key));
    for (const dep of ref.dependsOn ?? []) {
      const produced = (getJob(dep)?.produces ?? []).map((c) => c.key);
      if (!produced.some((k) => consumes.has(k))) {
        errors.push(`edge ${dep} → ${ref.job} has no validation gate: no artifact key that "${dep}" produces and "${ref.job}" consumes`);
      }
    }
  }
  return errors;
}

/** The gates of a ports workflow: one per binding, in the shape the DAG view and gate pages use. */
export function portGates(wf: Pick<WorkflowDefinition, 'name' | 'jobs'>, getJob: JobLookup): Gate[] {
  return bindWorkflowPorts(wf, getJob).bindings.map((b) => ({
    key: b.artifactKey,
    producer: b.producer,
    consumer: b.consumer,
    description: getJob(b.producer)?.outputs?.[b.producerPort]?.artifact.description,
  }));
}

/** The DAG's first and last waves, used for a workflow's "overall" inputs and outputs. */
export function rootAndTerminalStages(wf: Pick<WorkflowDefinition, 'jobs'>): { roots: string[]; terminals: string[] } {
  const dag = buildDag(wf.jobs);
  return { roots: dag.waves[0] ?? [], terminals: dag.waves[dag.waves.length - 1] ?? [] };
}

/** Shallow listing helper for `dir` artifacts: `<dir>/<name>` for each file. */
export function dirFilePaths(listing: DirListing): string[] {
  return listing.files.map((f) => join(listing.path, f));
}
