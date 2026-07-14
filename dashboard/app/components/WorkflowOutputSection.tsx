'use client';

import { useEffect, useState } from 'react';
import { api, type WorkflowOutputItem, type WorkflowRunOutput } from '../lib/api';
import { renderOutputBody } from './OutputRenderer';
import { usePoll } from '../ui';

function OutputModal(
  { title, result, loading, error, onClose }: {
    title: string;
    result: WorkflowRunOutput | null;
    loading?: boolean;
    error?: string | null;
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
          {!loading && error && <p className="error" style={{ margin: 0 }}>Failed to load output: {error}</p>}
          {!loading && !error && result && result.found && renderOutputBody(result)}
          {!loading && !error && result && !result.found && (
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
  const [modal, setModal] = useState<{ item: WorkflowOutputItem; result: WorkflowRunOutput | null; error?: string } | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);

  const items = data?.items ?? [];

  async function openOutput(item: WorkflowOutputItem) {
    const k = `${item.jobName}:${item.itemKey}`;
    setLoadingKey(k);
    setModal({ item, result: null });
    try {
      const result = await api.workflowOutput(workflowName, item.jobName, item.itemKey);
      setModal({ item, result });
    } catch (err) {
      setModal({ item, result: null, error: err instanceof Error ? err.message : String(err) });
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
          loading={modal.result === null && !modal.error}
          error={modal.error}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
