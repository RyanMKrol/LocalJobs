// What a stage read and wrote in one workflow run, for the run page's Inputs &
// Outputs panel. Everything here is DERIVED from what the engine recorded; no
// stage writes anything for display.
//
// Two sources, decided per run:
//
//   ports   the run has `run_artifacts`. A stage's inputs are the artifacts the
//           engine resolved for it (`run_inputs`) plus the upstream ledger items
//           it worked on; its outputs are the artifacts it committed plus the
//           ledger items it changed. Rows are attributed by the stage attempt
//           that wrote them (`run_id`), so a stage that writes a ledger under a
//           different name needs no special case.
//
//   legacy  a run of a workflow that used produces/consumes contracts (or any run
//           from before per-run recording). A stage's outputs are its ledger rows
//           touched this run, its inputs its predecessors' rows: the old rule,
//           frozen here so old runs keep rendering.
//
// Both produce the SAME wire shape, with explicit display rows (`IoItem`), so the
// dashboard has one renderer and guesses nothing.
import { existsSync, statSync } from 'node:fs';
import { db } from '../db/index.js';
import {
  artifactsForWorkflowRun, fromStoredPath, getRunArtifact, getWorkflowJobs, getWorkItem, listRunsForWorkflowRun,
  runInputsForWorkflowRun, stageIoLists, type RunArtifactRow, type RunInputRow, type StageIoItem,
} from '../db/store.js';
import { buildDag } from './dag.js';
import { dirStats } from './hash.js';
import type { ArtifactType, IoItem } from './ports.js';
import type { GateResult, JobDefinition, WorkflowDefinition, WorkflowRunRow } from './types.js';

export const OVERALL = '__overall__';

/** One display row, plus where it came from. */
export interface IoRow extends IoItem {
  jobName: string;
  itemKey: string;
}

/** One artifact a stage was handed or committed. */
export interface ArtifactCard {
  id: number;
  /** The stage that committed it. */
  job: string;
  port: string;
  artifactKey: string;
  description: string | null;
  storage: string;
  format: string | null;
  ok: boolean;
  /** False when the producer carried it forward unchanged this run. */
  fresh: boolean;
  note: string | null;
  summary: string | null;
  itemCount: number | null;
  bytes: number | null;
  committedAtMs: number;
  /** The file to preview, for a single-file artifact. */
  preview: { path: string; format: string } | null;
  /** The value itself, for an inline artifact. */
  inline: unknown;
  /** A stored sample of its items (the full list is fetched on demand). */
  sample: IoItem[];
  /** The producer's own check result, as recorded when it committed. */
  check: GateResult | null;
  /** Inputs only: the consuming port, and what the engine found when resolving it. */
  consumerPort?: string;
  resolved?: { ok: boolean; reason: string | null };
  /** Inputs only: the subset of items the stage reported actually using. */
  used?: { total: number; items: IoItem[] };
}

export interface IoSide {
  artifacts: ArtifactCard[];
  items: IoRow[];
  itemTotal: number;
  /** Ports outputs only: items this stage re-recorded without changing (not listed). */
  unchangedCount?: number;
}

export interface StageIoResponse {
  job: string;
  mode: 'ports' | 'legacy';
  /** The stages (or, for legacy, ledger names) whose rows are the inputs / outputs. */
  predecessorJobs: string[];
  outputJobs: string[];
  limit: number;
  inputs: IoSide;
  outputs: IoSide;
}

export interface StageIoPage {
  limit: number;
  inputsOffset: number;
  outputsOffset: number;
}

type JobLookup = (name: string) => JobDefinition | undefined;

const parse = <T>(json: string | null | undefined): T | null => {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
};

// ───────────────────────────── display rows ─────────────────────────────

/** The preview a ledger detail points at, by the long-standing detail convention. */
function detailPreview(detail: Record<string, unknown> | null): { path: string; format: string } | undefined {
  if (!detail) return undefined;
  const format = typeof detail.format === 'string' && detail.format ? detail.format : 'markdown';
  if (typeof detail.markdown === 'string' && detail.markdown && format === 'markdown') return { path: detail.markdown, format };
  if (typeof detail.path === 'string' && detail.path) return { path: detail.path, format };
  if (typeof detail.markdown === 'string' && detail.markdown) return { path: detail.markdown, format: 'markdown' };
  return undefined;
}

/**
 * How a ledger item is shown when its stage declares no `describeItem`: its
 * title and, if its detail points at a file, a preview. No fields are invented.
 */
function defaultDescribe(detail: Record<string, unknown> | null, itemKey: string, title: string | null): Omit<IoItem, 'id'> {
  const name = title ?? (detail && typeof detail.name === 'string' && detail.name ? detail.name : null);
  return { title: name ?? itemKey, preview: detailPreview(detail) };
}

function describe(
  def: JobDefinition | undefined,
  detail: Record<string, unknown> | null,
  itemKey: string,
  title: string | null,
): Omit<IoItem, 'id'> {
  const fallback = defaultDescribe(detail, itemKey, title);
  if (!def?.describeItem || !detail) return fallback;
  try {
    const d = def.describeItem(detail, itemKey);
    return { ...fallback, ...d, preview: d.preview ?? fallback.preview };
  } catch {
    return fallback; // a throwing describeItem must not blank the panel
  }
}

/**
 * The frozen LEGACY mapping from a ledger row's detail to a display row: title
 * from `detail.name`, up to four scalar keys as fields in insertion order. This
 * is what the dashboard used to compute client-side. Kept only so runs recorded
 * before ports still render; nothing new should rely on it.
 */
const LEGACY_EXCLUDED = new Set(['name', 'markdown', 'path', 'format', 'attempts']);
function humanizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
export function legacyRow(item: StageIoItem): IoRow {
  const detail = item.detail && typeof item.detail === 'object' && !Array.isArray(item.detail) ? (item.detail as Record<string, unknown>) : null;
  const fields: { label: string; value: string }[] = [];
  if (detail) {
    for (const k of Object.keys(detail)) {
      if (fields.length >= 4) break;
      if (LEGACY_EXCLUDED.has(k)) continue;
      const v = detail[k];
      if (v === null || v === undefined) continue;
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') continue;
      const s = String(v);
      fields.push({ label: humanizeKey(k), value: s.length > 80 ? `${s.slice(0, 80)}…` : s });
    }
  }
  const name = detail && typeof detail.name === 'string' && detail.name ? detail.name : null;
  return {
    id: `${item.jobName}:${item.itemKey}`,
    jobName: item.jobName,
    itemKey: item.itemKey,
    title: name ?? item.itemKey,
    status: item.status,
    fields,
    preview: detailPreview(detail),
  };
}

// ───────────────────────────── artifacts ─────────────────────────────

function artifactTypeOf(getJob: JobLookup, a: RunArtifactRow): ArtifactType | undefined {
  return getJob(a.job_name)?.outputs?.[a.port]?.artifact;
}

function card(getJob: JobLookup, a: RunArtifactRow, input?: RunInputRow): ArtifactCard {
  const type = artifactTypeOf(getJob, a);
  const summary = parse<{ summary?: string; items?: IoItem[] }>(a.summary_json);
  const format = type?.format ?? (a.storage === 'json' || a.storage === 'inline' ? 'json' : null);
  const c: ArtifactCard = {
    id: a.id,
    job: a.job_name,
    port: a.port,
    artifactKey: a.artifact_key,
    description: type?.description ?? null,
    storage: a.storage,
    format,
    ok: a.ok === 1,
    fresh: a.fresh === 1,
    note: a.note,
    summary: summary?.summary ?? null,
    itemCount: a.item_count,
    bytes: a.bytes,
    committedAtMs: a.created_at_ms,
    preview: (a.storage === 'json' || a.storage === 'file') && a.path ? { path: a.path, format: format ?? 'text' } : null,
    inline: a.storage === 'inline' ? parse<unknown>(a.inline_json) : undefined,
    sample: summary?.items ?? [],
    check: parse<GateResult>(a.check_json),
  };
  if (input) {
    c.consumerPort = input.port;
    c.resolved = { ok: input.ok === 1, reason: input.reason };
    const used = parse<{ total: number; items: IoItem[] }>(input.used_json);
    if (used) c.used = used;
  }
  return c;
}

/** An input the engine could NOT resolve to an artifact: still shown, with the reason. */
function unresolvedCard(getJob: JobLookup, input: RunInputRow, consumer: string): ArtifactCard {
  const type = getJob(consumer)?.inputs?.[input.port]?.artifact;
  return {
    id: -input.id,
    job: input.producer_job,
    port: input.port,
    artifactKey: input.artifact_key,
    description: type?.description ?? null,
    storage: type?.storage ?? 'unknown',
    format: type?.format ?? null,
    ok: false,
    fresh: false,
    note: null,
    summary: null,
    itemCount: null,
    bytes: null,
    committedAtMs: input.checked_at_ms,
    preview: null,
    inline: undefined,
    sample: [],
    check: null,
    consumerPort: input.port,
    resolved: { ok: false, reason: input.reason },
  };
}

// ───────────────────────────── ports derivation ─────────────────────────────

interface SnapshotRow {
  job_name: string;
  item_key: string;
  status: string | null;
  detail: string | null;
  title: string | null;
  changed: number | null;
}

/** The stage attempts (run ids) of the given stages within one workflow run. */
function runIdsOf(workflowRunId: string, stages: string[]): { ids: string[]; stageOf: Map<string, string> } {
  const stageOf = new Map<string, string>();
  for (const r of listRunsForWorkflowRun(workflowRunId)) if (stages.includes(r.job_name)) stageOf.set(r.id, r.job_name);
  return { ids: [...stageOf.keys()], stageOf };
}

const marks = (n: number) => Array.from({ length: n }, () => '?').join(',');

/** Ledger items the given stages CHANGED this run, as display rows (paged). */
function changedItems(
  getJob: JobLookup,
  workflowRunId: string,
  stages: string[],
  limit: number,
  offset: number,
): { items: IoRow[]; total: number; unchanged: number } {
  const { ids } = runIdsOf(workflowRunId, stages);
  if (ids.length === 0) return { items: [], total: 0, unchanged: 0 };
  const where = `workflow_run_id = ? AND run_id IN (${marks(ids.length)})`;
  const counts = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN changed = 1 THEN 1 ELSE 0 END), 0) AS changed,
            COALESCE(SUM(CASE WHEN changed = 1 THEN 0 ELSE 1 END), 0) AS unchanged
     FROM work_item_runs WHERE ${where}`,
  ).get(workflowRunId, ...ids) as { changed: number; unchanged: number };
  const rows = db.prepare(
    `SELECT r.job_name, r.item_key, r.status, r.detail, r.title, r.changed, r.run_id
     FROM work_item_runs r WHERE ${where} AND r.changed = 1
     ORDER BY r.job_name, r.item_key LIMIT ? OFFSET ?`,
  ).all(workflowRunId, ...ids, limit, offset) as (SnapshotRow & { run_id: string })[];
  const stageOfRun = runIdsOf(workflowRunId, stages).stageOf;
  const items = rows.map((r): IoRow => {
    const detail = parse<Record<string, unknown>>(r.detail);
    // The describing stage is the one whose attempt WROTE the row, which may not
    // share the ledger's job name.
    const d = describe(getJob(stageOfRun.get(r.run_id) ?? r.job_name), detail, r.item_key, r.title);
    return { id: `${r.job_name}:${r.item_key}`, jobName: r.job_name, itemKey: r.item_key, status: r.status ?? undefined, ...d };
  });
  return { items, total: counts.changed, unchanged: counts.unchanged };
}

/**
 * The upstream ledger items a stage WORKED ON this run: the distinct
 * `input_job` / `input_key` references on the rows its attempts wrote. Each is
 * shown as it stood for this run when this run also wrote it, else as it stands
 * in the ledger (it was produced by an earlier run).
 */
function workedOnItems(
  getJob: JobLookup,
  workflowRunId: string,
  stage: string,
  limit: number,
  offset: number,
): { items: IoRow[]; total: number } {
  const { ids } = runIdsOf(workflowRunId, [stage]);
  if (ids.length === 0) return { items: [], total: 0 };
  const where = `workflow_run_id = ? AND run_id IN (${marks(ids.length)}) AND input_job IS NOT NULL AND input_key IS NOT NULL`;
  const total = (db.prepare(
    `SELECT COUNT(*) AS n FROM (SELECT DISTINCT input_job, input_key FROM work_item_runs WHERE ${where})`,
  ).get(workflowRunId, ...ids) as { n: number }).n;
  const refs = db.prepare(
    `SELECT DISTINCT input_job, input_key FROM work_item_runs WHERE ${where} ORDER BY input_job, input_key LIMIT ? OFFSET ?`,
  ).all(workflowRunId, ...ids, limit, offset) as { input_job: string; input_key: string }[];
  const snapshot = db.prepare(
    'SELECT status, detail, title, changed FROM work_item_runs WHERE workflow_run_id = ? AND job_name = ? AND item_key = ?',
  );
  const items = refs.map((ref): IoRow => {
    const snap = snapshot.get(workflowRunId, ref.input_job, ref.input_key) as Omit<SnapshotRow, 'job_name' | 'item_key'> | undefined;
    const ledger = getWorkItem(ref.input_job, ref.input_key);
    // A snapshot row holds the detail only when this run changed the item.
    const detailJson = snap?.changed === 1 ? snap.detail : (ledger?.detail ?? null);
    const d = describe(getJob(ref.input_job), parse<Record<string, unknown>>(detailJson), ref.input_key, snap?.title ?? null);
    return {
      id: `${ref.input_job}:${ref.input_key}`,
      jobName: ref.input_job,
      itemKey: ref.input_key,
      status: snap?.status ?? ledger?.status ?? undefined,
      ...d,
    };
  });
  return { items, total };
}

/** The latest committed artifact per (stage, port) in a run (later cycles / attempts win). */
function latestArtifacts(artifacts: RunArtifactRow[], finalRunIds: Set<string>): RunArtifactRow[] {
  const byPort = new Map<string, RunArtifactRow>();
  for (const a of artifacts) {
    if (!finalRunIds.has(a.run_id)) continue; // an attempt that later failed does not speak for the stage
    byPort.set(`${a.job_name}\0${a.port}`, a);
  }
  return [...byPort.values()];
}

function portsStageIo(
  getJob: JobLookup,
  run: WorkflowRunRow,
  wf: Pick<WorkflowDefinition, 'jobs'>,
  job: string,
  page: StageIoPage,
): StageIoResponse {
  const dag = buildDag(wf.jobs);
  const memberRuns = listRunsForWorkflowRun(run.id);
  // Each stage speaks through its LATEST attempt in the run.
  const finalRunIds = new Set<string>();
  const latestByJob = new Map<string, string>();
  for (const r of memberRuns) latestByJob.set(r.job_name, r.id);
  for (const id of latestByJob.values()) finalRunIds.add(id);
  const artifacts = latestArtifacts(artifactsForWorkflowRun(run.id), finalRunIds);
  const outputsOf = (stages: string[]) => artifacts.filter((a) => stages.includes(a.job_name)).map((a) => card(getJob, a));

  if (job === OVERALL) {
    // What went in: what the root stage(s) gathered. What came out: what the
    // final stage(s) produced, plus any stage marked as the workflow's product.
    const roots = dag.waves[0] ?? [];
    const terminals = new Set(dag.waves[dag.waves.length - 1] ?? []);
    for (const ref of wf.jobs) if (getJob(ref.job)?.product) terminals.add(ref.job);
    const outStages = [...terminals];
    const inStages = roots.filter((r) => !terminals.has(r));
    const ins = changedItems(getJob, run.id, inStages, page.limit, page.inputsOffset);
    const outs = changedItems(getJob, run.id, outStages, page.limit, page.outputsOffset);
    return {
      job: OVERALL,
      mode: 'ports',
      predecessorJobs: inStages,
      outputJobs: outStages,
      limit: page.limit,
      inputs: { artifacts: outputsOf(inStages), items: ins.items, itemTotal: ins.total },
      outputs: { artifacts: outputsOf(outStages), items: outs.items, itemTotal: outs.total, unchangedCount: outs.unchanged },
    };
  }

  // The stage's resolved inputs, latest cycle.
  const all = runInputsForWorkflowRun(run.id).filter((i) => i.job_name === job);
  const lastCycle = all.reduce((m, i) => Math.max(m, i.cycle), 0);
  const inputCards = all
    .filter((i) => i.cycle === lastCycle)
    .map((i) => {
      const a = i.artifact_id == null ? undefined : getRunArtifact(i.artifact_id);
      return a ? card(getJob, a, i) : unresolvedCard(getJob, i, job);
    });
  const worked = workedOnItems(getJob, run.id, job, page.limit, page.inputsOffset);
  const outs = changedItems(getJob, run.id, [job], page.limit, page.outputsOffset);
  return {
    job,
    mode: 'ports',
    predecessorJobs: dag.dependencies.get(job) ?? [],
    outputJobs: [job],
    limit: page.limit,
    inputs: { artifacts: inputCards, items: worked.items, itemTotal: worked.total },
    outputs: { artifacts: outputsOf([job]), items: outs.items, itemTotal: outs.total, unchangedCount: outs.unchanged },
  };
}

// ───────────────────────────── legacy derivation ─────────────────────────────

function legacyStageIo(
  run: WorkflowRunRow,
  wf: Pick<WorkflowDefinition, 'jobs' | 'outputJob'>,
  job: string,
  page: StageIoPage,
): StageIoResponse {
  const dag = buildDag(wf.jobs);
  const lastWave = dag.waves[dag.waves.length - 1] ?? [];
  let outputJobs: string[];
  let inputJobs: string[];
  if (job === OVERALL) {
    // `outputJob` may name a ledger job that is not a DAG member (T603).
    outputJobs = wf.outputJob ? [wf.outputJob] : lastWave;
    inputJobs = (dag.waves[0] ?? []).filter((j) => !outputJobs.includes(j));
  } else {
    inputJobs = dag.dependencies.get(job) ?? [];
    outputJobs = [wf.outputJob && lastWave.includes(job) ? wf.outputJob : job];
  }
  const lists = stageIoLists(outputJobs, inputJobs, run.id, page);
  return {
    job,
    mode: 'legacy',
    predecessorJobs: inputJobs,
    outputJobs,
    limit: page.limit,
    inputs: { artifacts: [], items: lists.inputs.map(legacyRow), itemTotal: lists.inputTotal },
    outputs: { artifacts: [], items: lists.outputs.map(legacyRow), itemTotal: lists.outputTotal },
  };
}

// ───────────────────────────── entry points ─────────────────────────────

/** Whether a run was recorded with ports (it has committed artifacts). */
export function runUsesPorts(workflowRunId: string): boolean {
  return !!db.prepare('SELECT 1 FROM run_artifacts WHERE workflow_run_id = ? LIMIT 1').get(workflowRunId);
}

/**
 * The Inputs & Outputs of one stage (or of the workflow overall) for one run.
 * Returns null when `job` is not a member of the workflow.
 */
export function stageIo(
  getJob: JobLookup,
  run: WorkflowRunRow,
  def: Pick<WorkflowDefinition, 'outputJob'> | undefined,
  job: string,
  page: StageIoPage,
): StageIoResponse | null {
  const jobs = getWorkflowJobs(run.workflow_name).map((m) => ({ job: m.job_name, dependsOn: m.depends_on }));
  const empty = (mode: 'ports' | 'legacy'): StageIoResponse => ({
    job, mode, predecessorJobs: [], outputJobs: [], limit: page.limit,
    inputs: { artifacts: [], items: [], itemTotal: 0 },
    outputs: { artifacts: [], items: [], itemTotal: 0 },
  });
  if (job !== OVERALL && !jobs.some((j) => j.job === job)) return null;
  const mode = runUsesPorts(run.id) ? 'ports' : 'legacy';
  if (jobs.length === 0) return empty(mode);
  try {
    return mode === 'ports'
      ? portsStageIo(getJob, run, { jobs }, job, page)
      : legacyStageIo(run, { jobs, outputJob: def?.outputJob }, job, page);
  } catch {
    return empty(mode); // a DAG that no longer builds: nothing to derive from
  }
}

/**
 * The full item list of one committed artifact, computed on demand from where
 * the artifact lives. An artifact is only as good as the file behind it, so this
 * first checks the file is still the one that was committed: if it has changed
 * since (a later run rewrote it), the items would describe that later run, so the
 * stored sample is returned instead, flagged.
 */
export function artifactItems(
  getJob: JobLookup,
  workflowRunId: string,
  artifactId: number,
  limit: number,
  offset: number,
): { found: boolean; items: IoItem[]; total: number; changedSinceRun: boolean; sampleOnly: boolean } {
  const none = { found: false, items: [], total: 0, changedSinceRun: false, sampleOnly: false };
  const a = getRunArtifact(artifactId);
  if (!a || a.workflow_run_id !== workflowRunId) return none;
  const stored = parse<{ items?: IoItem[] }>(a.summary_json)?.items ?? [];
  const sample = (changedSinceRun: boolean) => ({
    found: true,
    items: stored.slice(offset, offset + limit),
    total: a.item_count ?? stored.length,
    changedSinceRun,
    sampleOnly: true,
  });
  const type = artifactTypeOf(getJob, a);
  if (!type?.items) return sample(false);

  let location: string;
  if (a.storage === 'inline') location = a.inline_json ?? 'null';
  else if (a.storage === 'ledger') location = a.path ?? a.job_name;
  else {
    location = fromStoredPath(a.path ?? '');
    if (!existsSync(location)) return sample(true);
    const unchanged = a.storage === 'dir'
      ? dirStats(location).sha256 === a.sha256
      : (() => { const st = statSync(location); return st.size === a.bytes && Math.floor(st.mtimeMs) === a.mtime_ms; })();
    if (!unchanged) return sample(true);
  }
  try {
    const all = type.items(type.read(location) as never);
    return { found: true, items: all.slice(offset, offset + limit), total: all.length, changedSinceRun: false, sampleOnly: false };
  } catch {
    return sample(false);
  }
}
