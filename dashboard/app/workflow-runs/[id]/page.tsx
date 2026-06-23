'use client';

import { use, useCallback, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Dag } from '../../components/Dag';
import { api } from '../../lib/api';
import type { IoRow, Run, WorkflowIo, WorkflowRunOutput } from '../../lib/api';
import { StatusBadge, fmtDuration, fmtRelative, statusLabel, usePoll } from '../../ui';

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

/** Full-markdown popover — renders LLM/scraped markdown via react-markdown (XSS-safe:
 *  no rehype-raw, raw HTML in the content is escaped, not executed). YAML frontmatter
 *  is stripped and shown as a compact key-value header above the body. */
function MarkdownModal(
  { title, content, truncated, onClose }: { title: string; content: string; truncated?: boolean; onClose: () => void },
) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const { fields, body } = parseFrontmatter(content);

  return (
    <div className="db-modal-overlay" onClick={onClose}>
      <div className="db-modal md-modal" onClick={(e) => e.stopPropagation()}>
        <div className="db-modal-header">
          <span>{title}</span>
          <button className="db-modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="db-modal-body">
          {truncated && <p className="muted" style={{ margin: 0, fontSize: '0.82em' }}>⚠ Output is large — showing the first part only.</p>}
          {fields.length > 0 && (
            <dl className="md-fm">
              {fields.map(([k, v]) => (
                <div key={k} className="md-fm-row">
                  <dt className="md-fm-key">{k}</dt>
                  <dd className="md-fm-val">{v}</dd>
                </div>
              ))}
            </dl>
          )}
          <div className="md-body">
            <ReactMarkdown>{body}</ReactMarkdown>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Output cell for one IO row: lazily fetches the produced markdown ONCE, shows a
 * preview (title + excerpt), and opens the full markdown in a popover on click.
 * Falls back to the bare output key/detail when the item has no markdown
 * artifact (`found: false`) — e.g. a non-markdown-producing workflow.
 */
function OutputCell(
  { runId, row, onOpen }: { runId: string; row: IoRow; onOpen: (title: string, content: string, truncated: boolean) => void },
) {
  const [out, setOut] = useState<WorkflowRunOutput | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!row.outputJob || !row.outputKey) return;
    let alive = true;
    setLoading(true);
    api.workflowRunOutput(runId, row.outputJob, row.outputKey)
      .then((o) => { if (alive) setOut(o); })
      .catch(() => { if (alive) setOut(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [runId, row.outputJob, row.outputKey]);

  if (!row.outputKey) return <span className="muted">—</span>;

  const detailName =
    row.outputDetail && typeof (row.outputDetail as Record<string, unknown>).name === 'string'
      ? itemLabel(row.outputKey, row.outputDetail)
      : null;

  // Markdown artifact available → expressive, clickable preview.
  if (out?.found && out.content) {
    const { title, excerpt } = mdPreview(out.content);
    const heading = title ?? detailName ?? row.outputKey;
    const content = out.content;
    const truncated = !!out.truncated;
    return (
      <button
        type="button"
        className="md-preview"
        title="Open full markdown"
        onClick={() => onOpen(heading, content, truncated)}
      >
        <span className="md-preview-title">📄 {heading}</span>
        {excerpt && <span className="md-preview-excerpt">{excerpt}</span>}
        <span className="md-preview-file mono">{out.file ?? row.outputKey}</span>
      </button>
    );
  }

  // No markdown (or still loading) → fall back to the bare key + detail name.
  return (
    <>
      <div className="mono" style={{ fontSize: '0.82em' }}>{row.outputKey}</div>
      {detailName && <div className="muted" style={{ fontSize: '0.88em' }}>{detailName}</div>}
      {loading && <div className="muted" style={{ fontSize: '0.78em' }}>loading preview…</div>}
    </>
  );
}

/**
 * Input → Output mapping panel (T095 first cut; T110 expressive output).
 *
 * Joins first-stage work items to last-stage work items by root_key so each
 * input can be paired with its final output. Not scoped to this run — reflects
 * the workflow's global work-item ledger. Fan-out collapses to one output per
 * input. These limitations are noted in the panel header. The OUTPUT side shows
 * a preview of the produced markdown artifact (title + excerpt) and opens the
 * full markdown in a popover on click (T110).
 */
function IoPanel({ runId, data }: { runId: string; data: WorkflowIo }) {
  const { io, firstWave, lastWave, note } = data;
  const [modal, setModal] = useState<{ title: string; content: string; truncated: boolean } | null>(null);
  const openModal = useCallback(
    (title: string, content: string, truncated: boolean) => setModal({ title, content, truncated }),
    [],
  );
  if (io.length === 0 && firstWave.length === 0) return null;
  const singleStage = firstWave.length > 0 && firstWave[0] === lastWave?.[0];
  return (
    <>
      <h2>Input → Output mapping</h2>
      <div className="panel">
        {io.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>No work items recorded yet for this workflow.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Input</th>
                <th>Input status</th>
                {!singleStage && <th>Output</th>}
                {!singleStage && <th>Output status</th>}
              </tr>
            </thead>
            <tbody>
              {io.map((row) => (
                <tr key={row.inputKey}>
                  <td>
                    <div className="mono" style={{ fontSize: '0.82em' }}>{row.inputKey}</div>
                    {row.inputDetail && typeof (row.inputDetail as Record<string, unknown>).name === 'string' && (
                      <div className="muted" style={{ fontSize: '0.88em' }}>{itemLabel(row.inputKey, row.inputDetail)}</div>
                    )}
                  </td>
                  <td><span className={`badge ${row.inputStatus}`}>{row.inputStatus}</span></td>
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
        )}
        <p className="muted" style={{ fontSize: '0.82em', margin: '8px 0 0' }}>
          ⚠ First cut — {note}
        </p>
      </div>
      {modal && <MarkdownModal title={modal.title} content={modal.content} truncated={modal.truncated} onClose={() => setModal(null)} />}
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

  // IO mapping panel: poll at a slower cadence (it reads the global work-item
  // ledger, not run-scoped state, so rapid polling isn't needed).
  const { data: ioData } = usePoll(() => api.workflowRunIo(id), 5000, [id]);

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

  return (
    <>
      <p className="muted"><a href={run ? `/workflows/${run.workflow_name}` : '/workflows'}>← {run?.workflow_name ?? 'workflows'}</a></p>
      <div className="row">
        <h1 style={{ margin: 0 }}>Workflow run</h1>
        <div className="spacer" />
        {run && <span className={`badge ${run.status}`}>{statusLabel(run.status)}</span>}
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
      <p className="sub">{run?.progress_msg}{run ? ` · ${run.progress}%` : ''}{run?.duration_ms != null ? ` · ${fmtDuration(run.duration_ms)}` : ''}</p>

      {workflow && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <Dag members={workflow.jobs} statusByJob={statusByJob} runIdByJob={runIdByJob} gates={gates} from={`/workflow-runs/${id}`} workflowRunId={id} />
        </div>
      )}

      {ioData && <IoPanel runId={id} data={ioData} />}

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

      <h2>Framework logs</h2>
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
