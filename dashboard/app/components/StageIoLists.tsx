'use client';

import { useCallback, useState } from 'react';
import { MarkdownModal } from './MarkdownModal';
import { api } from '../lib/api';
import type { StageIoItem, WorkflowMember } from '../lib/api';
import { usePoll } from '../ui';

const OVERALL_TAB = '__overall__';

type ModalState =
  | { loading: true; title: string }
  | { loading: false; title: string; content: string; truncated: boolean };

/** Extract a display label from a work-item detail blob: prefers `detail.name`, falls back to the key. */
function itemLabel(key: string, detail: StageIoItem['detail']): string {
  if (detail && typeof detail.name === 'string' && detail.name) return detail.name;
  return key;
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
    onOpen: (title: string, contentPromise: Promise<{ content: string; truncated: boolean }>) => void;
  },
) {
  const label = itemLabel(item.itemKey, item.detail);
  const artifact = artifactPath(item.detail);

  const open = () => {
    const contentPromise = api.workflowRunOutput(runId, item.jobName, item.itemKey)
      .then((o) => ({ content: o.content ?? '', truncated: !!o.truncated }));
    onOpen(label, contentPromise);
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
    onOpen: (title: string, contentPromise: Promise<{ content: string; truncated: boolean }>) => void;
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
    (title: string, contentPromise: Promise<{ content: string; truncated: boolean }>) => {
      setModal({ loading: true, title });
      contentPromise
        .then(({ content, truncated }) => setModal({ loading: false, title, content, truncated }))
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
        <MarkdownModal
          title={modal.title}
          loading={modal.loading}
          content={!modal.loading ? modal.content : undefined}
          truncated={!modal.loading ? modal.truncated : undefined}
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
    (title: string, contentPromise: Promise<{ content: string; truncated: boolean }>) => {
      setModal({ loading: true, title });
      contentPromise
        .then(({ content, truncated }) => setModal({ loading: false, title, content, truncated }))
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
        <MarkdownModal
          title={modal.title}
          loading={modal.loading}
          content={!modal.loading ? modal.content : undefined}
          truncated={!modal.loading ? modal.truncated : undefined}
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
