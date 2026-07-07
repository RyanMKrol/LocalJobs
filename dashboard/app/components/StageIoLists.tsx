'use client';

import { useCallback, useState } from 'react';
import { renderOutputBody } from './OutputRenderer';
import { api } from '../lib/api';
import type { StageIoItem, WorkflowMember, WorkflowRunOutput } from '../lib/api';
import { usePoll } from '../ui';

const OVERALL_TAB = '__overall__';

type ModalState =
  | { loading: true; title: string }
  | { loading: false; title: string; result: WorkflowRunOutput };

/** The workflow-run output modal, rendered via the shared format-keyed
 *  dispatch (`OutputRenderer`) so a `json`/`text` artifact renders through its
 *  real renderer instead of being force-fed through the markdown viewer. */
function StageIoModal({ title, loading, result, onClose }: {
  title: string;
  loading: boolean;
  result?: WorkflowRunOutput;
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
          {!loading && result && result.found && renderOutputBody(result)}
          {!loading && result && !result.found && (
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
      <span className={`badge ${item.status}`}>{item.status}</span>
    </li>
  );
}

function StageIoColumn(
  { title, items, runId, emptyText, onOpen }: {
    title: string;
    items: StageIoItem[];
    runId: string;
    emptyText: string;
    onOpen: (title: string, resultPromise: Promise<WorkflowRunOutput>) => void;
  },
) {
  return (
    <div className="stage-io-col">
      <h4 className="stage-io-col-heading">{title}{items.length > 0 ? ` · ${items.length}` : ''}</h4>
      {items.length === 0 ? (
        <p className="muted" style={{ margin: 0, fontSize: '0.85em' }}>{emptyText}</p>
      ) : (
        <ul className="stage-io-list">
          {items.map((item) => (
            <StageIoItemRow key={`${item.jobName}:${item.itemKey}`} runId={runId} item={item} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** One workflow member's decoupled inputs/outputs — polls its own
 *  `GET /workflow-runs/:id/stage-io?job=` independently of the other members. */
function StageIoBlock({ runId, jobName }: { runId: string; jobName: string }) {
  const [modal, setModal] = useState<ModalState | null>(null);
  const { data } = usePoll(() => api.workflowRunStageIo(runId, jobName), 5000, [runId, jobName]);

  const openModal = useCallback(
    (title: string, resultPromise: Promise<WorkflowRunOutput>) => {
      setModal({ loading: true, title });
      resultPromise
        .then((result) => setModal({ loading: false, title, result }))
        .catch(() => setModal(null));
    },
    [],
  );

  if (!data) return null;

  return (
    <div className="panel stage-io-block">
      <h3 className="stage-io-stage-name">{jobName}</h3>
      <div className="stage-io-columns">
        <StageIoColumn
          title="Inputs"
          items={data.inputs}
          runId={runId}
          emptyText="No inputs — this is the root stage."
          onOpen={openModal}
        />
        <StageIoColumn
          title="Outputs"
          items={data.outputs}
          runId={runId}
          emptyText="Nothing recorded this run."
          onOpen={openModal}
        />
      </div>
      {modal && (
        <StageIoModal
          title={modal.title}
          loading={modal.loading}
          result={!modal.loading ? modal.result : undefined}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

/** The workflow-wide "Overall" tab — polls `GET /workflow-runs/:id/stage-io?overall=true`
 *  (T384) to show the run's root-wave inputs and effective terminal-wave outputs,
 *  independent of any single stage's own inputs/outputs. */
function StageIoOverallBlock({ runId }: { runId: string }) {
  const [modal, setModal] = useState<ModalState | null>(null);
  const { data } = usePoll(() => api.workflowRunStageIoOverall(runId), 5000, [runId]);

  const openModal = useCallback(
    (title: string, resultPromise: Promise<WorkflowRunOutput>) => {
      setModal({ loading: true, title });
      resultPromise
        .then((result) => setModal({ loading: false, title, result }))
        .catch(() => setModal(null));
    },
    [],
  );

  if (!data) return null;

  return (
    <div className="panel stage-io-block">
      <h3 className="stage-io-stage-name">Overall</h3>
      <div className="stage-io-columns">
        <StageIoColumn
          title="Inputs"
          items={data.inputs}
          runId={runId}
          emptyText="No inputs recorded this run."
          onOpen={openModal}
        />
        <StageIoColumn
          title="Outputs"
          items={data.outputs}
          runId={runId}
          emptyText="Nothing recorded this run."
          onOpen={openModal}
        />
      </div>
      {modal && (
        <StageIoModal
          title={modal.title}
          loading={modal.loading}
          result={!modal.loading ? modal.result : undefined}
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
        <StageIoOverallBlock runId={runId} />
      ) : (
        visibleMembers.map((m) => <StageIoBlock key={m.job_name} runId={runId} jobName={m.job_name} />)
      )}
    </>
  );
}
