'use client';

import { use, useCallback, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { DagFlow } from '../../components/DagFlow';
import { api } from '../../lib/api';
import type { IoRow, Run, WorkflowIo, WorkflowMember } from '../../lib/api';
import type { RunStatus } from '../../lib/api';
import { CopyLogsButton, StatusBadge, fmtDuration, fmtRelative, usePoll } from '../../ui';

function latestByStage(members: Run[]): Run[] {
  const latest = new Map<string, Run>();
  // members arrive ordered by (started_at, rowid) — the rowid tiebreaker (T112) is
  // what makes "last write wins" correct during fast repeatUntilStable cycling,
  // where an earlier cycle's settled run and the current cycle's running run can
  // share a clock second. The final value per key is the genuinely-latest run, so
  // a stale "succeeded" never overwrites the live "running" (no status flicker).
  // Map preserves first-insertion order, so stage order is maintained.
  for (const r of members) latest.set(r.job_name, r);
  return [...latest.values()];
}


/** Extract a display label from a work-item detail blob: prefers `detail.name`, falls back to `key`. */
function itemLabel(key: string, detail: IoRow['inputDetail']): string {
  if (detail && typeof detail.name === 'string' && detail.name) return detail.name;
  return key;
}

/**
 * Derive a human title + a short excerpt from a produced markdown profile, so
 * the IO panel can show a meaningful preview of the output without rendering the
 * whole file. Title: the YAML frontmatter `name:` if present, else the first
 * `# ` heading, else null. Excerpt: the first couple of body lines (skipping
 * frontmatter, headings and blank lines), trimmed to a short snippet.
 */
function mdPreview(content: string): { title: string | null; excerpt: string | null } {
  let body = content;
  let title: string | null = null;

  // Strip leading YAML frontmatter (--- … ---) and mine it for `name:`.
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3);
    if (end !== -1) {
      const fm = body.slice(3, end);
      const m = fm.match(/^\s*name:\s*(.+?)\s*$/m);
      if (m) title = m[1].replace(/^["']|["']$/g, '').trim() || null;
      body = body.slice(end + 4);
    }
  }

  const lines = body.split('\n').map((l) => l.trim());
  if (!title) {
    const h = lines.find((l) => /^#{1,6}\s+/.test(l));
    if (h) title = h.replace(/^#{1,6}\s+/, '').trim() || null;
  }

  const bodyLine = lines.find((l) => l !== '' && !/^#{1,6}\s+/.test(l) && l !== '---');
  let excerpt = bodyLine ?? null;
  if (excerpt && excerpt.length > 140) excerpt = `${excerpt.slice(0, 140)}…`;
  return { title, excerpt };
}

/**
 * Strip YAML frontmatter from markdown and return the parsed fields + body.
 * Returns `{ fields: [key, value][], body: string }`.
 */
function parseFrontmatter(content: string): { fields: [string, string][]; body: string } {
  if (!content.startsWith('---')) return { fields: [], body: content };
  const end = content.indexOf('\n---', 3);
  if (end === -1) return { fields: [], body: content };
  const fm = content.slice(3, end);
  const body = content.slice(end + 4).replace(/^\n/, '');
  const fields: [string, string][] = [];
  for (const line of fm.split('\n')) {
    const m = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (m) fields.push([m[1], m[2].replace(/^["']|["']$/g, '').trim()]);
  }
  return { fields, body };
}

/** Returns true if a raw frontmatter value string is effectively empty/null. */
function isFmEmpty(v: string): boolean {
  if (!v || v === 'null' || v === '~') return true;
  try { const p = JSON.parse(v); return Array.isArray(p) && p.length === 0; } catch { return false; }
}

/** Render a raw frontmatter value: JSON arrays become comma-separated text; empty/null values
 *  get a highlighted placeholder so missing data is visible rather than silently absent. */
function renderFmValue(v: string): React.ReactNode {
  if (isFmEmpty(v)) return <span className="md-fm-null">null</span>;
  try {
    const p = JSON.parse(v);
    if (Array.isArray(p) && p.every((x) => x === null || typeof x !== 'object')) {
      return p.join(', ');
    }
  } catch { /* not a JSON array — render as-is */ }
  return v;
}

/** Full-markdown popover — renders LLM/scraped markdown via react-markdown (XSS-safe:
 *  no rehype-raw, raw HTML in the content is escaped, not executed). YAML frontmatter
 *  is stripped and shown as a compact key-value header above the body.
 *  When `loading` is true the body shows a loading indicator instead of content. */
function MarkdownModal(
  { title, content, truncated, loading, onClose }: {
    title: string;
    content?: string;
    truncated?: boolean;
    loading?: boolean;
    onClose: () => void;
  },
) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const parsed = content ? parseFrontmatter(content) : null;

  return (
    <div className="db-modal-overlay" onClick={onClose}>
      <div className="db-modal md-modal" onClick={(e) => e.stopPropagation()}>
        <div className="db-modal-header">
          <span>{title}</span>
          <button className="db-modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="db-modal-body">
          {loading && <p className="muted" style={{ margin: 0 }}>Loading…</p>}
          {!loading && parsed && (
            <>
              {truncated && <p className="muted" style={{ margin: 0, fontSize: '0.82em' }}>⚠ Output is large — showing the first part only.</p>}
              {parsed.fields.length > 0 && (
                <dl className="md-fm">
                  {parsed.fields.map(([k, v]) => (
                    <div key={k} className="md-fm-row">
                      <dt className="md-fm-key">{k}</dt>
                      <dd className="md-fm-val">{renderFmValue(v)}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <div className="md-body">
                <ReactMarkdown>{parsed.body}</ReactMarkdown>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Output cell for one IO row — two-phase, no mount-time fetch.
 *
 * Phase 1 (instant): derives filename and label from `row.outputDetail` already
 * present on the row (`outputDetail.markdown` → basename; `outputDetail.name` →
 * label). Renders the final meta layout immediately so the column never reflows.
 *
 * Phase 2 (lazy): fetches the full markdown content only when the user clicks
 * "click to preview". The `onOpen` callback is given the title and a Promise
 * for the content; the parent shows a loading state in the popover while it resolves.
 *
 * Falls back to showing the bare key/name (no preview) when there is no markdown
 * path recorded on the row, and renders `—` when there is no output key at all.
 */
function OutputCell(
  { runId, row, onOpen }: {
    runId: string;
    row: IoRow;
    onOpen: (title: string, contentPromise: Promise<{ content: string; truncated: boolean }>) => void;
  },
) {
  if (!row.outputKey) return <span className="muted">—</span>;

  const detailName =
    row.outputDetail && typeof (row.outputDetail as Record<string, unknown>).name === 'string'
      ? itemLabel(row.outputKey, row.outputDetail)
      : null;

  const mdPath =
    row.outputDetail && typeof (row.outputDetail as Record<string, unknown>).markdown === 'string'
      ? (row.outputDetail as Record<string, unknown>).markdown as string
      : null;

  // No markdown path recorded — show key/name, no preview (no fetch needed).
  if (!mdPath) {
    return (
      <>
        <div className="mono" style={{ fontSize: '0.82em' }}>{row.outputKey}</div>
        {detailName && <div className="muted" style={{ fontSize: '0.88em' }}>{detailName}</div>}
      </>
    );
  }

  // Derive display name from the recorded path (no fetch).
  const shortName = mdPath.split('/').pop() ?? mdPath;
  const heading = detailName ?? shortName;

  const open = () => {
    const contentPromise = api.workflowRunOutput(runId, row.outputJob!, row.outputKey!)
      .then((o) => ({ content: o.content ?? '', truncated: !!o.truncated }));
    onOpen(heading, contentPromise);
  };

  return (
    <div className="out-meta">
      <button type="button" className="out-meta-link" onClick={open} title={mdPath}>{shortName}</button>
      <span className="out-meta-info muted">click to preview</span>
    </div>
  );
}

/**
 * Input → Output mapping panel (T095; T110 expressive output; T139 run-scoped).
 *
 * Shows the inputs THIS run actually advanced (driven by the `work_item_runs`
 * linkage) paired with their final outputs, resolved from the first/last-stage
 * work items by root_key. A run that advanced nothing new, or an old run created
 * before per-run IO was recorded, renders an honest explanatory empty state
 * instead of dumping the whole ledger. The OUTPUT side shows a preview of the
 * produced markdown artifact (title + excerpt) and opens the full markdown in a
 * popover on click (T110).
 */
type ModalState =
  | { loading: true; title: string }
  | { loading: false; title: string; content: string; truncated: boolean };

/** Derive the "effective" state of a row for filtering purposes.
 *  For single-stage workflows only the input status matters.
 *  For multi-stage workflows the output status is the terminal outcome; fall
 *  back to the input status when there is no output yet. */
function rowEffectiveState(row: IoRow, singleStage: boolean): string {
  if (singleStage) return row.inputStatus;
  return row.outputStatus ?? row.inputStatus;
}

const IO_FILTER_STATES = ['all', 'success', 'failed', 'skipped'] as const;
type IoFilterState = typeof IO_FILTER_STATES[number];

function IoPanel({ runId, members }: { runId: string; members: WorkflowMember[] }) {
  const [modal, setModal] = useState<ModalState | null>(null);
  const [filter, setFilter] = useState<IoFilterState>('all');
  const [selectedJob, setSelectedJob] = useState<string | null>(null);

  const { data } = usePoll(() => api.workflowRunIo(runId, selectedJob ?? undefined), 5000, [runId, selectedJob]);

  // Opens the preview popover immediately (with a loading state) and resolves
  // the content Promise to fill it in — so the column never fetches on mount.
  const openModal = useCallback(
    (title: string, contentPromise: Promise<{ content: string; truncated: boolean }>) => {
      setModal({ loading: true, title });
      contentPromise
        .then(({ content, truncated }) => setModal({ loading: false, title, content, truncated }))
        .catch(() => setModal(null));
    },
    [],
  );
  if (!data) return null;
  const { io, firstWave, lastWave, emptyReason, note, scopedProducerJobs, scopedConsumerJobs } = data;
  if (io.length === 0 && firstWave.length === 0) return null;
  const singleStage = selectedJob != null
    ? (scopedProducerJobs?.length === 1 && scopedProducerJobs[0] === scopedConsumerJobs?.[0])
    : (firstWave.length > 0 && firstWave[0] === lastWave?.[0]);
  const emptyMessage = emptyReason === 'pre-feature'
    ? "Per-run input/output isn't recorded for runs created before this feature."
    : 'This run processed no new items.';

  // Tally counts per state for chip labels.
  const stateCounts: Record<string, number> = {};
  for (const row of io) {
    const s = rowEffectiveState(row, singleStage);
    stateCounts[s] = (stateCounts[s] ?? 0) + 1;
  }

  const filtered = filter === 'all' ? io : io.filter((r) => rowEffectiveState(r, singleStage) === filter);

  const inputHeader = selectedJob != null && !singleStage
    ? `Input (${scopedProducerJobs.join(', ')})`
    : 'Input';
  const outputHeader = selectedJob != null && !singleStage
    ? `Output (${selectedJob})`
    : 'Output';

  const selectJob = (jobName: string | null) => {
    setSelectedJob(jobName);
    setFilter('all');
  };

  return (
    <>
      <h2>Input → Output mapping{io.length > 0 ? ` · ${io.length.toLocaleString()} items` : ''}</h2>
      <div className="panel" style={{ overflow: 'hidden' }}>
        {members.length > 1 && (
          <div className="io-job-filter-bar">
            <button
              type="button"
              className={`io-job-filter-chip${selectedJob === null ? ' active' : ''}`}
              onClick={() => selectJob(null)}
            >
              All stages
            </button>
            {members.map((m) => (
              <button
                key={m.job_name}
                type="button"
                className={`io-job-filter-chip${selectedJob === m.job_name ? ' active' : ''}`}
                onClick={() => selectJob(m.job_name)}
              >
                {m.job_name}
              </button>
            ))}
          </div>
        )}
        {io.length === 0 ? (
          <p className="io-empty-state">{emptyMessage}</p>
        ) : (
          <>
            <div className="io-filter-bar">
              {IO_FILTER_STATES.map((s) => {
                const count = s === 'all' ? io.length : (stateCounts[s] ?? 0);
                return (
                  <button
                    key={s}
                    type="button"
                    className={`io-filter-chip${filter === s ? ' active' : ''}${s !== 'all' ? ` io-filter-chip--${s}` : ''}`}
                    onClick={() => setFilter(s)}
                    disabled={s !== 'all' && count === 0}
                  >
                    {s} <span className="io-filter-count">{count}</span>
                  </button>
                );
              })}
            </div>
            {filtered.length === 0 ? (
              <p className="io-empty-state" style={{ paddingTop: 12 }}>No {filter} items in this run.</p>
            ) : (
              <>
                <div className="io-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>{inputHeader}</th>
                      <th>State</th>
                      {!singleStage && <th>{outputHeader}</th>}
                      {!singleStage && <th>Output state</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((row) => (
                      <tr key={row.inputKey}>
                        <td>
                          <div className="mono" style={{ fontSize: '0.82em' }}>{row.inputKey}</div>
                          {row.inputDetail && typeof (row.inputDetail as Record<string, unknown>).name === 'string' && (
                            <div className="muted" style={{ fontSize: '0.88em' }}>{itemLabel(row.inputKey, row.inputDetail)}</div>
                          )}
                        </td>
                        <td>
                          <span className={`badge ${row.inputStatus}`}>{row.inputStatus}</span>
                          {!singleStage && row.outputStatus && row.outputStatus !== row.inputStatus && (
                            <span className="io-state-arrow">→ <span className={`badge ${row.outputStatus}`}>{row.outputStatus}</span></span>
                          )}
                        </td>
                        {!singleStage && (
                          <td><OutputCell runId={runId} row={row} onOpen={openModal} /></td>
                        )}
                        {!singleStage && (
                          <td>
                            {row.outputStatus
                              ? <span className={`badge ${row.outputStatus}`}>{row.outputStatus}</span>
                              : <span className="muted">—</span>}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
                {!singleStage && <p className="io-footnote">{note}</p>}
              </>
            )}
          </>
        )}
      </div>
      {modal && (
        <MarkdownModal
          title={modal.title}
          loading={modal.loading}
          content={modal.loading ? undefined : modal.content}
          truncated={modal.loading ? undefined : modal.truncated}
          onClose={() => setModal(null)}
        />
      )}
    </>
  );
}

export default function WorkflowRunDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [busy, setBusy] = useState(false);
  const { data } = usePoll(() => api.workflowRun(id), 2000, [id]);
  const run = data?.run;
  const members = data?.jobs ?? [];
  const logs = data?.logs ?? [];
  const gates = data?.gates ?? [];

  async function cancel() {
    setBusy(true);
    try { await api.cancelWorkflowRun(id); } catch { /* poll will reflect new status */ } finally { setTimeout(() => setBusy(false), 1200); }
  }

  // Fetch the workflow definition (for the DAG edges) once we know its name.
  const { data: pdata } = usePoll(
    () => api.workflow(run?.workflow_name ?? '__none__'),
    5000,
    [run?.workflow_name],
  );
  const workflow = pdata?.workflow;

  // Latest member run per stage (members are ordered by (started_at, rowid), so the
  // last write per job is the genuinely-latest run — see latestByStage / T112).
  const statusByJob: Record<string, string> = {};
  const runIdByJob: Record<string, string> = {};
  for (const r of members) { statusByJob[r.job_name] = r.status; runIdByJob[r.job_name] = r.id; }

  const latestRuns = latestByStage(members);

  const totalStages = workflow?.jobs.length ?? latestRuns.length;
  const completedStages = latestRuns.filter(r => r.status !== 'queued' && r.status !== 'running').length;

  return (
    <>
      <p className="muted"><a href={run ? `/workflows/${run.workflow_name}` : '/workflows'}>← {run?.workflow_name ?? 'workflows'}</a></p>
      <div className="row">
        <h1 style={{ margin: 0 }}>Workflow run</h1>
        <div className="spacer" />
        {run && <StatusBadge status={run.status as RunStatus} />}
        {run?.run_limit != null && (
          <span className="badge queued" title="This run was limited to N originating inputs (all their fan-out ran).">
            {run.run_limit} input{run.run_limit === 1 ? '' : 's'} limit
          </span>
        )}
        {run?.status === 'running' && (
          <button className="btn btn-danger" onClick={cancel} disabled={busy}>
            {busy ? 'Cancelling…' : '✕ Cancel'}
          </button>
        )}
      </div>
      <p className="sub">{run ? `${completedStages} of ${totalStages} stages` : ''}{run ? ` · ${run.progress}%` : ''}{run?.duration_ms != null ? ` · ${fmtDuration(run.duration_ms)}` : ''}</p>

      {workflow && (
        <div className="panel dag-panel" style={{ marginBottom: 16 }}>
          <DagFlow members={workflow.jobs} statusByJob={statusByJob} runIdByJob={runIdByJob} gates={gates} from={`/workflow-runs/${id}`} workflowRunId={id} />
        </div>
      )}

      {workflow && <IoPanel runId={id} members={workflow.jobs} />}

      <h2>Member runs</h2>
      <div className="panel">
        <table>
          <thead><tr><th>Stage</th><th>Status</th><th>When</th><th>Duration</th><th></th></tr></thead>
          <tbody>
            {members.length === 0 && <tr><td colSpan={5} className="muted">No member runs yet.</td></tr>}
            {latestRuns.map((r) => (
              <tr key={r.id}>
                <td><strong>{r.job_name}</strong></td>
                <td><StatusBadge status={r.status} /></td>
                <td className="muted">{fmtRelative(r.started_at)}</td>
                <td className="mono">{fmtDuration(r.duration_ms)}</td>
                <td><a href={`/runs/${r.id}`}>logs →</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <h2>Framework logs</h2>
        <div style={{ marginBottom: 12 }}><CopyLogsButton logs={logs} /></div>
      </div>
      <div className="logs">
        {logs.length === 0 && <span className="muted">No framework logs yet.</span>}
        {logs.map((l) => (
          <div key={l.id} className={`lvl-${l.level}`}>
            <span className="ts">{l.ts.split(' ')[1] ?? l.ts}</span>{l.message}
          </div>
        ))}
      </div>
    </>
  );
}
