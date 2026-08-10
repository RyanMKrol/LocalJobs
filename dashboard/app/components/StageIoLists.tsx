'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { renderOutputBody } from './OutputRenderer';
import { api } from '../lib/api';
import type { StageIo, StageIoItem, StageIoPageParams, WorkflowMember, WorkflowRunOutput } from '../lib/api';
import { StatusBadge, usePoll } from '../ui';

const OVERALL_TAB = '__overall__';

/** Rows fetched per page — the panel NEVER loads a full list up front. A
 *  27k-item run (plex-rename) used to ship both complete lists into the DOM in
 *  one shot, hard-freezing the tab; pages now lazy-load as the user scrolls. */
export const STAGE_IO_PAGE_SIZE = 100;

/** De-dupe by ledger identity — a poll refresh of page one can overlap
 *  already-appended pages when new rows shift the stable ordering mid-run. */
export function dedupeStageIoItems(items: StageIoItem[]): StageIoItem[] {
  const seen = new Set<string>();
  const out: StageIoItem[] = [];
  for (const item of items) {
    const k = `${item.jobName}:${item.itemKey}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

type ModalState =
  | { loading: true; title: string }
  | { loading: false; title: string; result: WorkflowRunOutput }
  | { loading: false; title: string; error: string };

/** The workflow-run output modal, rendered via the shared format-keyed
 *  dispatch (`OutputRenderer`) so a `json`/`text` artifact renders through its
 *  real renderer instead of being force-fed through the markdown viewer. On a
 *  fetch failure the modal STAYS OPEN and shows the error inline, rather than
 *  silently closing (which used to make a View click flash and vanish). */
function StageIoModal({ title, loading, result, error, onClose }: {
  title: string;
  loading: boolean;
  result?: WorkflowRunOutput;
  error?: string;
  onClose: () => void;
}) {
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

/** Extract a display label from a work-item detail blob: prefers `detail.name`, falls back to the key. */
function itemLabel(key: string, detail: StageIoItem['detail']): string {
  if (detail && typeof detail.name === 'string' && detail.name) return detail.name;
  return key;
}

/** Detail keys handled elsewhere (name is the label; the rest are artifact/bookkeeping
 *  plumbing) — never shown as generic hint pills. */
const DETAIL_HINT_EXCLUDED_KEYS = new Set(['name', 'markdown', 'path', 'format', 'attempts']);

const MAX_DETAIL_HINT_VALUE_LENGTH = 80;
const MAX_DETAIL_HINTS = 4;

/** Humanize a camelCase/snake_case detail key into a Title Case label, e.g.
 *  `placeId` -> 'Place Id', `resolved_count` -> 'Resolved Count'. */
export function humanizeDetailKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function truncateDetailValue(value: string): string {
  if (value.length <= MAX_DETAIL_HINT_VALUE_LENGTH) return value;
  return `${value.slice(0, MAX_DETAIL_HINT_VALUE_LENGTH - 1)}…`;
}

export interface DetailHint {
  label: string;
  value: string;
}

/** Extract up to `MAX_DETAIL_HINTS` labeled scalar fields from a work-item detail blob,
 *  beyond the primary `name` label — a scannable proof of what a stage actually recorded
 *  (a resolved place_id, a rating, a resolved count, …), without dumping the whole blob. */
export function detailHints(detail: StageIoItem['detail']): DetailHint[] {
  if (!detail) return [];
  const hints: DetailHint[] = [];
  for (const key of Object.keys(detail)) {
    if (hints.length >= MAX_DETAIL_HINTS) break;
    if (DETAIL_HINT_EXCLUDED_KEYS.has(key)) continue;
    const value = detail[key];
    if (value === null || value === undefined) continue;
    const type = typeof value;
    if (type !== 'string' && type !== 'number' && type !== 'boolean') continue;
    hints.push({ label: humanizeDetailKey(key), value: truncateDetailValue(String(value)) });
  }
  return hints;
}

/** The path to an artifact this item's stage produced, if any — `detail.markdown` for a
 *  markdown artifact (T110) or `detail.path` for any other declared output form (T262,
 *  generalized to every stage, not just a workflow's terminal one). Either is served by
 *  the same `GET /workflow-runs/:id/output` endpoint, so both get the same preview link. */
function artifactPath(detail: StageIoItem['detail']): string | null {
  if (detail && typeof detail.markdown === 'string' && detail.markdown) return detail.markdown as string;
  if (detail && typeof detail.path === 'string' && detail.path) return detail.path as string;
  return null;
}

/** One row in a decoupled inputs/outputs list — a key + optional name/detail summary,
 *  with a click-to-preview affordance when the item recorded a produced artifact
 *  (markdown or otherwise). */
function StageIoItemRow(
  { runId, item, onOpen }: {
    runId: string;
    item: StageIoItem;
    onOpen: (title: string, resultPromise: Promise<WorkflowRunOutput>) => void;
  },
) {
  const label = itemLabel(item.itemKey, item.detail);
  const artifact = artifactPath(item.detail);
  const hints = detailHints(item.detail);

  const open = () => {
    const resultPromise = api.workflowRunOutput(runId, item.jobName, item.itemKey);
    onOpen(label, resultPromise);
  };

  return (
    <li className="stage-io-item">
      <div className="stage-io-item-meta">
        <div className="stage-io-item-key">{item.itemKey}</div>
        {label !== item.itemKey && !artifact && <div className="stage-io-item-name">{label}</div>}
        {artifact && (
          <button type="button" className="stage-io-item-link" onClick={open} title={artifact}>
            {label} — click to preview
          </button>
        )}
        {hints.length > 0 && (
          <div className="stage-io-item-hints">
            {hints.map((h) => (
              <span key={h.label} className="stage-io-item-hint">{h.label}: {h.value}</span>
            ))}
          </div>
        )}
      </div>
      <StatusBadge status={item.status} />
    </li>
  );
}

function StageIoColumn(
  { title, items, total, runId, emptyText, onOpen, more }: {
    title: string;
    items: StageIoItem[];
    /** Full row count for this side, independent of how many pages are loaded. */
    total: number;
    runId: string;
    emptyText: string;
    onOpen: (title: string, resultPromise: Promise<WorkflowRunOutput>) => void;
    /** Lazy paging trigger, rendered INSIDE the list (the list is its own 320px
     *  scroll container, so an outside sentinel would always be "visible" and
     *  eagerly load everything — inside, clipping keeps it un-intersected until
     *  the user actually scrolls the column near its bottom). */
    more?: { loading: boolean; onLoadMore: () => void };
  },
) {
  const countLabel = total > items.length ? ` · ${items.length} of ${total}` : items.length > 0 ? ` · ${items.length}` : '';
  return (
    <div className="stage-io-col">
      <h4 className="stage-io-col-heading">{title}{countLabel}</h4>
      {items.length === 0 ? (
        <p className="muted" style={{ margin: 0, fontSize: '0.85em' }}>{emptyText}</p>
      ) : (
        <ul className="stage-io-list">
          {items.map((item) => (
            <StageIoItemRow key={`${item.jobName}:${item.itemKey}`} runId={runId} item={item} onOpen={onOpen} />
          ))}
          {more && items.length < total && (
            <li>
              <LoadMoreSentinel loading={more.loading} onLoadMore={more.onLoadMore} label={`${items.length} of ${total} loaded`} />
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/** Infinite-scroll trigger: fires `onLoadMore` when scrolled into view (with a
 *  generous margin so pages arrive before the user reaches the bottom), and
 *  doubles as a manual "Load more" button. Rendered only while more rows exist. */
export function LoadMoreSentinel(
  { loading, onLoadMore, label }: { loading: boolean; onLoadMore: () => void; label: string },
) {
  const ref = useRef<HTMLDivElement>(null);
  const loadRef = useRef(onLoadMore);
  loadRef.current = onLoadMore;
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadRef.current();
      },
      { rootMargin: '400px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  return (
    <div ref={ref} className="stage-io-load-more">
      <button type="button" className="btn btn-sm" onClick={() => loadRef.current()} disabled={loading}>
        {loading ? 'Loading…' : `Load more (${label})`}
      </button>
    </div>
  );
}

/** Shared lazy-paging state over the stage-io endpoint: the FIRST page stays on
 *  the 5s poll (so a live run's newest rows and statuses keep refreshing), and
 *  further pages append on demand as the sentinel scrolls into view. */
function useLazyStageIo(
  fetchPage: (page: StageIoPageParams) => Promise<StageIo | (StageIo & { outputJobs: string[] })>,
  deps: unknown[],
) {
  const { data } = usePoll(() => fetchPage({ limit: STAGE_IO_PAGE_SIZE, inputsOffset: 0, outputsOffset: 0 }), 5000, deps);
  const [extraInputs, setExtraInputs] = useState<StageIoItem[]>([]);
  const [extraOutputs, setExtraOutputs] = useState<StageIoItem[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);

  const inputs = useMemo(() => dedupeStageIoItems([...(data?.inputs ?? []), ...extraInputs]), [data, extraInputs]);
  const outputs = useMemo(() => dedupeStageIoItems([...(data?.outputs ?? []), ...extraOutputs]), [data, extraOutputs]);
  const inputTotal = data?.inputTotal ?? inputs.length;
  const outputTotal = data?.outputTotal ?? outputs.length;
  const hasMore = inputs.length < inputTotal || outputs.length < outputTotal;

  const loadMore = useCallback(async () => {
    if (loadingMore || !data) return;
    setLoadingMore(true);
    try {
      const page = await fetchPage({
        limit: STAGE_IO_PAGE_SIZE,
        inputsOffset: inputs.length,
        outputsOffset: outputs.length,
      });
      setExtraInputs((prev) => [...prev, ...page.inputs]);
      setExtraOutputs((prev) => [...prev, ...page.outputs]);
    } finally {
      setLoadingMore(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingMore, data, inputs.length, outputs.length]);

  return { data, inputs, outputs, inputTotal, outputTotal, hasMore, loadMore, loadingMore };
}

/** The Inputs column's empty-state text (T607). A stage with NO predecessors at all is
 *  the DAG's actual root — "root stage" is accurate. A stage WITH predecessors that simply
 *  recorded zero ledger rows this run (e.g. its upstream stage found nothing to hand off)
 *  is NOT the root — showing the root-stage text there is factually wrong. */
export function inputsEmptyText(predecessorJobs: string[]): string {
  return predecessorJobs.length === 0
    ? 'No inputs — this is the root stage.'
    : 'No inputs recorded this run.';
}

/** One decoupled inputs/outputs block — a single workflow member (job tab) or
 *  the workflow-wide Overall view, depending on the fetcher passed in. The
 *  first page of each side stays live on the poll; further pages lazy-load via
 *  the sentinel as the user scrolls (never everything up front). */
function StageIoLazyBlock(
  { runId, heading, fetchPage, deps, inputsEmpty }: {
    runId: string;
    heading: string;
    fetchPage: (page: StageIoPageParams) => Promise<StageIo>;
    deps: unknown[];
    inputsEmpty: (predecessorJobs: string[]) => string;
  },
) {
  const [modal, setModal] = useState<ModalState | null>(null);
  const { data, inputs, outputs, inputTotal, outputTotal, hasMore, loadMore, loadingMore } = useLazyStageIo(fetchPage, deps);

  const openModal = useCallback(
    (title: string, resultPromise: Promise<WorkflowRunOutput>) => {
      setModal({ loading: true, title });
      resultPromise
        .then((result) => setModal({ loading: false, title, result }))
        .catch((err) => setModal({ loading: false, title, error: err instanceof Error ? err.message : String(err) }));
    },
    [],
  );

  if (!data) return null;

  return (
    <div className="panel stage-io-block">
      <h3 className="stage-io-stage-name">{heading}</h3>
      <div className="stage-io-columns">
        <StageIoColumn
          title="Inputs"
          items={inputs}
          total={inputTotal}
          runId={runId}
          emptyText={inputsEmpty(data.predecessorJobs)}
          onOpen={openModal}
          more={hasMore ? { loading: loadingMore, onLoadMore: loadMore } : undefined}
        />
        <StageIoColumn
          title="Outputs"
          items={outputs}
          total={outputTotal}
          runId={runId}
          emptyText="Nothing recorded this run."
          onOpen={openModal}
          more={hasMore ? { loading: loadingMore, onLoadMore: loadMore } : undefined}
        />
      </div>
      {modal && (
        <StageIoModal
          title={modal.title}
          loading={modal.loading}
          result={!modal.loading && 'result' in modal ? modal.result : undefined}
          error={!modal.loading && 'error' in modal ? modal.error : undefined}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

/**
 * Decoupled per-stage inputs/outputs panel — an alternative to the generic
 * joined `IoPanel` for `stock-digest`, whose `stock-digest-build` stage is a
 * genuine many-to-one aggregation (many tickers/sectors → one report) that a
 * single joined "input → output" row can't represent honestly (see the
 * stock-digest.workflow.ts file comment / root CLAUDE.md). Renders one block
 * per DAG member, each showing its OWN inputs (its direct predecessor(s)'
 * ledger rows this run) and OWN outputs (its own ledger rows this run) as two
 * independent lists — no attempt to pair them into rows.
 *
 * Tabbed (mirrors the generic IoPanel's `.io-job-filter-chip` bar): showing all
 * three stages' blocks stacked at once was too busy, so a chip bar selects ONE
 * stage at a time — defaulting to the FIRST stage rather than "All stages" (the
 * generic panel's default), since "All stages" here is exactly the busy view.
 */
export function StageIoPanel({ runId, members }: { runId: string; members: WorkflowMember[] }) {
  const [selectedJob, setSelectedJob] = useState<string | null>(OVERALL_TAB);
  if (members.length === 0) return null;
  const visibleMembers = selectedJob === null || selectedJob === OVERALL_TAB
    ? members
    : members.filter((m) => m.job_name === selectedJob);

  return (
    <>
      <h2>Inputs &amp; outputs</h2>
      <div className="panel" style={{ marginBottom: 12, overflow: 'hidden' }}>
        <div className="io-job-filter-bar" style={{ borderBottom: 'none' }}>
          <button
            type="button"
            className={`io-job-filter-chip${selectedJob === OVERALL_TAB ? ' active' : ''}`}
            onClick={() => setSelectedJob(OVERALL_TAB)}
          >
            Overall
          </button>
          {members.length > 1 && (
            <button
              type="button"
              className={`io-job-filter-chip${selectedJob === null ? ' active' : ''}`}
              onClick={() => setSelectedJob(null)}
            >
              All stages
            </button>
          )}
          {members.map((m) => (
            <button
              key={m.job_name}
              type="button"
              className={`io-job-filter-chip${selectedJob === m.job_name ? ' active' : ''}`}
              onClick={() => setSelectedJob(m.job_name)}
            >
              {m.job_name}
            </button>
          ))}
        </div>
      </div>
      {selectedJob === OVERALL_TAB ? (
        <StageIoLazyBlock
          key={OVERALL_TAB}
          runId={runId}
          heading="Overall"
          fetchPage={(page) => api.workflowRunStageIoOverall(runId, page)}
          deps={[runId]}
          inputsEmpty={() => 'No inputs recorded this run.'}
        />
      ) : (
        visibleMembers.map((m) => (
          <StageIoLazyBlock
            key={m.job_name}
            runId={runId}
            heading={m.job_name}
            fetchPage={(page) => api.workflowRunStageIo(runId, m.job_name, page)}
            deps={[runId, m.job_name]}
            inputsEmpty={inputsEmptyText}
          />
        ))
      )}
    </>
  );
}
