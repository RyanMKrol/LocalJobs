'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { renderOutputBody } from './OutputRenderer';
import { api } from '../lib/api';
import type { IoItem, StageIo, StageIoArtifact, StageIoItem, StageIoPageParams, WorkflowMember, WorkflowRunOutput } from '../lib/api';
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

/** "1.2 MB" style size, for an artifact card. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

/** The small facts shown under an artifact's name: item count, size, freshness. */
export function artifactFacts(a: Pick<StageIoArtifact, 'itemCount' | 'bytes' | 'storage'>): string[] {
  const facts: string[] = [];
  if (a.itemCount != null) facts.push(`${a.itemCount} item${a.itemCount === 1 ? '' : 's'}`);
  if (a.bytes != null && a.storage !== 'inline') facts.push(formatBytes(a.bytes));
  return facts;
}

type ModalState =
  | { kind: 'file'; loading: true; title: string }
  | { kind: 'file'; loading: false; title: string; result: WorkflowRunOutput }
  | { kind: 'file'; loading: false; title: string; error: string }
  | { kind: 'items'; title: string; artifact: StageIoArtifact };

/** Open a file preview (a row's or an artifact's) by its recorded path. */
type OpenFile = (title: string, preview: { path: string; format: string }) => void;

function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="db-modal-overlay" onClick={onClose}>
      <div className="db-modal md-modal" onClick={(e) => e.stopPropagation()}>
        <div className="db-modal-header">
          <span>{title}</span>
          <button className="db-modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="db-modal-body">{children}</div>
      </div>
    </div>
  );
}

/** One display row: a ledger item, or an item of an artifact. Everything shown
 *  (title, fields, preview) comes from the server as explicit data. */
function IoRowView({ row, itemKey, onOpenFile }: { row: IoItem; itemKey?: string; onOpenFile: OpenFile }) {
  const showKey = itemKey !== undefined && itemKey !== row.title;
  return (
    <li className="stage-io-item">
      <div className="stage-io-item-meta">
        {showKey && <div className="stage-io-item-key">{itemKey}</div>}
        {row.preview ? (
          <button type="button" className="stage-io-item-link" onClick={() => onOpenFile(row.title, row.preview!)} title={row.preview.path}>
            {row.title} — click to preview
          </button>
        ) : (
          <div className={showKey ? 'stage-io-item-name' : 'stage-io-item-key'}>{row.title}</div>
        )}
        {row.subtitle && <div className="stage-io-item-name">{row.subtitle}</div>}
        {row.fields && row.fields.length > 0 && (
          <div className="stage-io-item-hints">
            {row.fields.map((f) => (
              <span key={f.label} className="stage-io-item-hint" title={`${f.label}: ${f.value}`}>{f.label}: {f.value}</span>
            ))}
          </div>
        )}
      </div>
      {row.status && <StatusBadge status={row.status} />}
    </li>
  );
}

/** The full item list of one artifact, paged from the server on demand. */
function ArtifactItemsBrowser({ runId, artifact, onOpenFile }: { runId: string; artifact: StageIoArtifact; onOpenFile: OpenFile }) {
  const [items, setItems] = useState<IoItem[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loaded = useRef(0);

  const load = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    try {
      const page = await api.workflowRunArtifactItems(runId, artifact.id, { limit: STAGE_IO_PAGE_SIZE, offset: loaded.current });
      loaded.current += page.items.length;
      setItems((prev) => [...prev, ...page.items]);
      setTotal(page.sampleOnly ? loaded.current : page.total);
      setNote(
        page.changedSinceRun
          ? `The file behind this artifact has been rewritten since this run. Showing the ${loaded.current} item(s) sampled when the run committed it${page.total > loaded.current ? ` (of ${page.total})` : ''}.`
          : page.sampleOnly && page.total > loaded.current
            ? `Showing a sample of ${loaded.current} of ${page.total} item(s).`
            : null,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, artifact.id, loading]);

  useEffect(() => { void load(); /* first page */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      {note && <p className="muted" style={{ marginTop: 0 }}>{note}</p>}
      {error && <p className="error" style={{ marginTop: 0 }}>Failed to load items: {error}</p>}
      {items.length === 0 && !loading && !error && <p className="muted" style={{ margin: 0 }}>No items.</p>}
      <ul className="stage-io-list stage-io-list-tall">
        {items.map((it) => <IoRowView key={it.id} row={it} onOpenFile={onOpenFile} />)}
        {total !== null && items.length < total && (
          <li><LoadMoreSentinel loading={loading} onLoadMore={() => void load()} label={`${items.length} of ${total} loaded`} /></li>
        )}
      </ul>
    </>
  );
}

/**
 * One artifact a stage was handed or committed: what it is, where it came from,
 * how big, whether it passed its check, whether it is new this run. For an input,
 * also whether the engine could resolve it, and which of its items the stage
 * said it actually used.
 */
function ArtifactCardView(
  { artifact, side, onOpenFile, onBrowse, committed }: {
    artifact: StageIoArtifact;
    side: 'input' | 'output';
    onOpenFile: OpenFile;
    onBrowse: (a: StageIoArtifact) => void;
    /** Show when it was committed and link to that run (used outside a run page). */
    committed?: boolean;
  },
) {
  const unresolved = artifact.resolved && !artifact.resolved.ok;
  const failed = unresolved || !artifact.ok;
  // A summary already says how many of what ("9 suggestions"); only the size is extra.
  const facts = artifactFacts(artifact.summary ? { ...artifact, itemCount: null } : artifact);
  const name = side === 'input' ? (artifact.consumerPort ?? artifact.port) : artifact.port;
  const violations = artifact.check && !artifact.check.ok ? (artifact.check.violations ?? []) : [];
  const hasItems = (artifact.itemCount ?? 0) > 0 || artifact.sample.length > 0;
  const inline = artifact.storage === 'inline' && artifact.inline !== undefined;
  return (
    <li className={`stage-io-item stage-io-artifact${failed ? ' stage-io-artifact-failed' : ''}`}>
      <div className="stage-io-item-meta">
        <div className="stage-io-artifact-head">
          <span className="stage-io-artifact-port">{name}</span>
          <span className="stage-io-item-hint">{artifact.artifactKey}</span>
          {side === 'input' && <span className="stage-io-item-name">from {artifact.job}</span>}
          {!committed && !artifact.fresh && !unresolved && (
            artifact.note
              ? <span className="stage-io-item-hint stage-io-hint-carried" title={artifact.note}>carried forward</span>
              : <span className="stage-io-item-hint stage-io-hint-carried" title="Written this run, and identical to what it was before.">unchanged</span>
          )}
          {committed && (
            <span className="stage-io-item-name">
              {artifact.job} · {artifact.fresh ? 'written' : 'last checked'} {new Date(artifact.committedAtMs).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
              {artifact.workflowRunId && <> · <a href={`/workflow-runs/${artifact.workflowRunId}`}>run</a></>}
            </span>
          )}
        </div>
        {artifact.description && <div className="stage-io-item-name">{artifact.description}</div>}
        {(artifact.summary || facts.length > 0) && (
          <div className="stage-io-artifact-summary">{[artifact.summary, ...facts].filter(Boolean).join(' · ')}</div>
        )}
        {unresolved && <div className="stage-io-artifact-problem">Not resolved: {artifact.resolved!.reason}</div>}
        {!unresolved && violations.length > 0 && <div className="stage-io-artifact-problem">Failed its check: {violations.join('; ')}</div>}
        {inline && <pre className="stage-io-inline">{JSON.stringify(artifact.inline, null, 2)}</pre>}
        {artifact.used && (
          <div className="stage-io-artifact-used">
            <div className="stage-io-item-name">Used {artifact.used.total} of {artifact.itemCount ?? '?'}:</div>
            <ul className="stage-io-list stage-io-list-nested">
              {artifact.used.items.map((it) => <IoRowView key={it.id} row={it} onOpenFile={onOpenFile} />)}
            </ul>
          </div>
        )}
        <div className="stage-io-artifact-actions">
          {artifact.preview && (
            <button type="button" className="stage-io-item-link" onClick={() => onOpenFile(`${artifact.job} · ${artifact.port}`, artifact.preview!)} title={artifact.preview.path}>
              View file
            </button>
          )}
          {hasItems && (
            <button type="button" className="stage-io-item-link" onClick={() => onBrowse(artifact)}>
              Browse {artifact.itemCount ?? artifact.sample.length} item{(artifact.itemCount ?? artifact.sample.length) === 1 ? '' : 's'}
            </button>
          )}
        </div>
      </div>
      <StatusBadge status={failed ? 'failed' : 'success'} />
    </li>
  );
}

function StageIoColumn(
  { title, side, artifacts, items, total, unchanged, emptyText, onOpenFile, onBrowse, more }: {
    title: string;
    side: 'input' | 'output';
    artifacts: StageIoArtifact[];
    items: StageIoItem[];
    /** Full row count for this side, independent of how many pages are loaded. */
    total: number;
    /** Items re-recorded without change this run (outputs only): counted, not listed. */
    unchanged?: number;
    emptyText: string;
    onOpenFile: OpenFile;
    onBrowse: (a: StageIoArtifact) => void;
    /** Lazy paging trigger, rendered INSIDE the list (the list is its own 320px
     *  scroll container, so an outside sentinel would always be "visible" and
     *  eagerly load everything — inside, clipping keeps it un-intersected until
     *  the user actually scrolls the column near its bottom). */
    more?: { loading: boolean; onLoadMore: () => void };
  },
) {
  const countLabel = total > items.length ? ` · ${items.length} of ${total}` : items.length > 0 ? ` · ${items.length}` : '';
  const nothing = artifacts.length === 0 && items.length === 0;
  return (
    <div className="stage-io-col">
      <h4 className="stage-io-col-heading">{title}</h4>
      {nothing && <p className="muted" style={{ margin: 0, fontSize: '0.85em' }}>{emptyText}</p>}
      {artifacts.length > 0 && (
        <ul className="stage-io-list stage-io-artifacts">
          {artifacts.map((a) => (
            <ArtifactCardView key={`${a.id}:${a.consumerPort ?? ''}`} artifact={a} side={side} onOpenFile={onOpenFile} onBrowse={onBrowse} />
          ))}
        </ul>
      )}
      {items.length > 0 && (
        <>
          <h5 className="stage-io-sub-heading">Items{countLabel}</h5>
          <ul className="stage-io-list">
            {items.map((item) => (
              <IoRowView key={`${item.jobName}:${item.itemKey}`} row={item} itemKey={item.itemKey} onOpenFile={onOpenFile} />
            ))}
            {more && items.length < total && (
              <li>
                <LoadMoreSentinel loading={more.loading} onLoadMore={more.onLoadMore} label={`${items.length} of ${total} loaded`} />
              </li>
            )}
          </ul>
        </>
      )}
      {!!unchanged && (
        <p className="muted" style={{ margin: '6px 0 0', fontSize: '0.8em' }}>
          {unchanged} more item{unchanged === 1 ? '' : 's'} re-recorded with no change.
        </p>
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
function useLazyStageIo(fetchPage: (page: StageIoPageParams) => Promise<StageIo>, deps: unknown[]) {
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

  // A fetch failure keeps the modal OPEN and shows the error inline, rather than
  // silently closing (which used to make a View click flash and vanish).
  const openFile: OpenFile = useCallback((title, preview) => {
    setModal({ kind: 'file', loading: true, title });
    api.outputFile(preview.path, preview.format)
      .then((result) => setModal({ kind: 'file', loading: false, title, result }))
      .catch((err) => setModal({ kind: 'file', loading: false, title, error: err instanceof Error ? err.message : String(err) }));
  }, []);
  const browse = useCallback((artifact: StageIoArtifact) => {
    setModal({ kind: 'items', title: `${artifact.job} · ${artifact.port}`, artifact });
  }, []);

  if (!data) return null;

  return (
    <div className="panel stage-io-block">
      <h3 className="stage-io-stage-name">{heading}</h3>
      <div className="stage-io-columns">
        <StageIoColumn
          title="Inputs"
          side="input"
          artifacts={data.inputArtifacts ?? []}
          items={inputs}
          total={inputTotal}
          emptyText={inputsEmpty(data.predecessorJobs)}
          onOpenFile={openFile}
          onBrowse={browse}
          more={hasMore ? { loading: loadingMore, onLoadMore: loadMore } : undefined}
        />
        <StageIoColumn
          title="Outputs"
          side="output"
          artifacts={data.outputArtifacts ?? []}
          items={outputs}
          total={outputTotal}
          unchanged={data.outputsUnchanged}
          emptyText="Nothing recorded this run."
          onOpenFile={openFile}
          onBrowse={browse}
          more={hasMore ? { loading: loadingMore, onLoadMore: loadMore } : undefined}
        />
      </div>
      {modal?.kind === 'file' && (
        <ModalShell title={modal.title} onClose={() => setModal(null)}>
          {modal.loading && <p className="muted" style={{ margin: 0 }}>Loading…</p>}
          {!modal.loading && 'error' in modal && <p className="error" style={{ margin: 0 }}>Failed to load output: {modal.error}</p>}
          {!modal.loading && 'result' in modal && modal.result.found && renderOutputBody(modal.result)}
          {!modal.loading && 'result' in modal && !modal.result.found && (
            <p className="muted" style={{ margin: 0 }}>No output content found. The file may have been moved or removed since this run.</p>
          )}
        </ModalShell>
      )}
      {modal?.kind === 'items' && (
        <ModalShell title={modal.title} onClose={() => setModal(null)}>
          <ArtifactItemsBrowser runId={runId} artifact={modal.artifact} onOpenFile={openFile} />
        </ModalShell>
      )}
    </div>
  );
}

/**
 * A workflow's product, on the workflow page: the latest artifact each output of
 * its product stage committed, as the same cards the run page shows. Each card
 * says which run committed it and links there.
 */
export function ProductArtifacts({ artifacts }: { artifacts: StageIoArtifact[] }) {
  const [modal, setModal] = useState<ModalState | null>(null);
  const openFile: OpenFile = useCallback((title, preview) => {
    setModal({ kind: 'file', loading: true, title });
    api.outputFile(preview.path, preview.format)
      .then((result) => setModal({ kind: 'file', loading: false, title, result }))
      .catch((err) => setModal({ kind: 'file', loading: false, title, error: err instanceof Error ? err.message : String(err) }));
  }, []);
  const browse = useCallback((artifact: StageIoArtifact) => {
    setModal({ kind: 'items', title: `${artifact.job} · ${artifact.port}`, artifact });
  }, []);
  if (artifacts.length === 0) return null;
  return (
    <div className="panel stage-io-block">
      <ul className="stage-io-list stage-io-artifacts">
        {artifacts.map((a) => (
          <ArtifactCardView key={a.id} artifact={a} side="output" onOpenFile={openFile} onBrowse={browse} committed />
        ))}
      </ul>
      {modal?.kind === 'file' && (
        <ModalShell title={modal.title} onClose={() => setModal(null)}>
          {modal.loading && <p className="muted" style={{ margin: 0 }}>Loading…</p>}
          {!modal.loading && 'error' in modal && <p className="error" style={{ margin: 0 }}>Failed to load output: {modal.error}</p>}
          {!modal.loading && 'result' in modal && modal.result.found && renderOutputBody(modal.result)}
          {!modal.loading && 'result' in modal && !modal.result.found && (
            <p className="muted" style={{ margin: 0 }}>No output content found. The file may have been moved or removed.</p>
          )}
        </ModalShell>
      )}
      {modal?.kind === 'items' && modal.artifact.workflowRunId && (
        <ModalShell title={modal.title} onClose={() => setModal(null)}>
          <ArtifactItemsBrowser runId={modal.artifact.workflowRunId} artifact={modal.artifact} onOpenFile={openFile} />
        </ModalShell>
      )}
    </div>
  );
}

/**
 * The workflow-run page's Inputs & Outputs panel: one block per stage (or the
 * workflow overall), each with two independent, un-paired sides. A side shows
 * the ARTIFACTS the stage was handed or committed and the ledger ITEMS it worked
 * on or changed. Everything is what the engine recorded for THIS run; the stage
 * writes nothing for display, and the dashboard infers nothing.
 *
 * A chip bar selects one stage at a time (showing every stage stacked was too
 * busy); "Overall" is the default: what the root stage gathered, and what the
 * final stage produced.
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
