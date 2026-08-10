'use client';

import { useEffect, useMemo, useState } from 'react';
import { api, type WorkflowOutputItem, type WorkflowRunOutput } from '../lib/api';
import { renderOutputBody } from './OutputRenderer';
import { LoadMoreSentinel, STAGE_IO_PAGE_SIZE } from './StageIoLists';
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
  // First page stays on the poll (fresh counts + newest items); further pages
  // lazy-load on scroll — a workflow with tens of thousands of output items
  // (plex-rename) must never render them all up front.
  const { data, error } = usePoll(
    () => api.workflowOutputItems(workflowName, { limit: STAGE_IO_PAGE_SIZE, offset: 0 }),
    10_000,
    [workflowName],
  );
  const [modal, setModal] = useState<{ item: WorkflowOutputItem; result: WorkflowRunOutput | null; error?: string } | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [extraItems, setExtraItems] = useState<WorkflowOutputItem[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);

  const items = useMemo(() => {
    const seen = new Set<string>();
    const out: WorkflowOutputItem[] = [];
    for (const item of [...(data?.items ?? []), ...extraItems]) {
      const k = `${item.jobName}:${item.itemKey}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(item);
    }
    return out;
  }, [data, extraItems]);
  const total = data?.total ?? items.length;
  const hasMore = items.length < total;

  async function loadMore() {
    if (loadingMore || !data) return;
    setLoadingMore(true);
    try {
      const page = await api.workflowOutputItems(workflowName, { limit: STAGE_IO_PAGE_SIZE, offset: items.length });
      setExtraItems((prev) => [...prev, ...page.items]);
    } finally {
      setLoadingMore(false);
    }
  }

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

  const label = hasMore
    ? `${items.length} of ${total} items loaded`
    : items.length === 1 ? '1 item' : `${items.length} items`;

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
                          {item.viewable && (
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
          {hasMore && (
            <LoadMoreSentinel loading={loadingMore} onLoadMore={loadMore} label={`${items.length} of ${total} loaded`} />
          )}
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
