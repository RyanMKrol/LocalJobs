'use client';

import { useEffect, useState, type ReactElement } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, type WorkflowOutputItem, type WorkflowRunOutput } from '../lib/api';
import { usePoll } from '../ui';

/** Parse YAML frontmatter out of markdown content. */
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

/**
 * Renders a markdown output artifact's body (T262/T282 'markdown' form — the
 * default/legacy form; unchanged behaviour from before the format dispatch).
 */
function MarkdownOutputBody({ content, truncated }: { content: string; truncated?: boolean }) {
  const parsed = parseFrontmatter(content);
  return (
    <>
      {truncated && (
        <p className="muted" style={{ margin: 0, fontSize: '0.82em' }}>
          ⚠ Output is large — showing the first part only.
        </p>
      )}
      {parsed.fields.length > 0 && (
        <dl className="md-fm">
          {parsed.fields.map(([k, v]) => (
            <div key={k} className="md-fm-row">
              <dt className="md-fm-key">{k}</dt>
              <dd className="md-fm-val">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="md-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{parsed.body}</ReactMarkdown>
      </div>
    </>
  );
}

/**
 * Fallback renderer for a declared form with no dedicated renderer yet — shows
 * the raw content so a new form (e.g. T263's structured size table) is usable
 * before its own renderer is added, rather than rendering nothing.
 */
function RawOutputBody({ content, truncated }: { content: string; truncated?: boolean }) {
  return (
    <>
      {truncated && (
        <p className="muted" style={{ margin: 0, fontSize: '0.82em' }}>
          ⚠ Output is large — showing the first part only.
        </p>
      )}
      <pre
        style={{
          fontSize: 13,
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          background: 'var(--panel-2)',
          borderRadius: 6,
          padding: '10px 12px',
          margin: 0,
        }}
      >
        {content}
      </pre>
    </>
  );
}

/**
 * Renderer dispatch keyed by an output item's declared form (`WorkflowRunOutput.format`,
 * T262). Add a new form's renderer here — the extension point this refactor exists for.
 * A format with no entry falls back to `RawOutputBody` rather than failing to render.
 */
const OUTPUT_RENDERERS: Record<string, (props: { content: string; truncated?: boolean }) => ReactElement> = {
  markdown: MarkdownOutputBody,
};

function renderOutputBody(result: WorkflowRunOutput): ReactElement {
  const Renderer = (result.format && OUTPUT_RENDERERS[result.format]) || RawOutputBody;
  return <Renderer content={result.content ?? ''} truncated={result.truncated} />;
}

function OutputModal(
  { title, result, loading, onClose }: {
    title: string;
    result: WorkflowRunOutput | null;
    loading?: boolean;
    onClose: () => void;
  },
) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="db-modal-overlay" onClick={onClose}>
      <div className="db-modal md-modal" onClick={(e) => e.stopPropagation()}>
        <div className="db-modal-header">
          <span>{title}</span>
          <button className="db-modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="db-modal-body">
          {loading && <p className="muted" style={{ margin: 0 }}>Loading…</p>}
          {!loading && result && result.found && renderOutputBody(result)}
          {!loading && result && !result.found && (
            <p className="muted" style={{ margin: 0 }}>No output content found.</p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Generic unified output section for any workflow that produces terminal-stage
 * work items with markdown artifacts (e.g. places, perfumes). Reads from
 * GET /api/workflows/:name/output-items — items are de-duped by (job_name, item_key)
 * by construction (the work_items ledger is keyed by that pair). (T205)
 */
export function WorkflowOutputSection({ workflowName }: { workflowName: string }) {
  const { data, error } = usePoll(() => api.workflowOutputItems(workflowName), 10_000, [workflowName]);
  const [modal, setModal] = useState<{ item: WorkflowOutputItem; result: WorkflowRunOutput | null } | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);

  const items = data?.items ?? [];

  async function openOutput(item: WorkflowOutputItem) {
    const k = `${item.jobName}:${item.itemKey}`;
    setLoadingKey(k);
    setModal({ item, result: null });
    try {
      const result = await api.workflowOutput(workflowName, item.jobName, item.itemKey);
      setModal({ item, result });
    } catch {
      setModal(null);
    } finally {
      setLoadingKey(null);
    }
  }

  const label = items.length === 1 ? '1 item' : `${items.length} items`;

  return (
    <div className="output-section">
      <h2>Output</h2>
      <p className="muted" style={{ fontSize: 13 }}>
        Items produced by this workflow, de-duplicated by stable item key. Each item appears exactly
        once — re-runs that process the same item update it in place, never duplicate it.
      </p>

      {error && <p className="error">Failed to load output: {String(error)}</p>}

      {data && items.length === 0 && (
        <div className="panel">
          <p className="empty-state-panel">
            No output yet. Run the workflow — produced items will appear here.
          </p>
        </div>
      )}

      {items.length > 0 && (
        <>
          <p className="muted" style={{ fontSize: 13, marginBottom: 8 }}>{label}</p>
          <div className="movie-gaps-scroll">
            <div className="panel">
              <table>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Key</th>
                    <th>Updated</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const k = `${item.jobName}:${item.itemKey}`;
                    return (
                      <tr key={k}>
                        <td>{item.name ?? <span className="muted">—</span>}</td>
                        <td className="muted mono" style={{ fontSize: 12 }}>{item.itemKey}</td>
                        <td className="muted" style={{ fontSize: 12 }}>{item.updatedAt}</td>
                        <td style={{ textAlign: 'right' }}>
                          {item.hasMarkdown && (
                            <button
                              className="btn btn-sm"
                              onClick={() => openOutput(item)}
                              disabled={loadingKey === k}
                            >
                              {loadingKey === k ? 'Loading…' : 'View'}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {modal && (
        <OutputModal
          title={modal.item.name ?? modal.item.itemKey}
          result={modal.result}
          loading={modal.result === null}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
