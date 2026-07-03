'use client';

import { useCallback, useState } from 'react';
import { MarkdownModal } from './MarkdownModal';
import { api } from '../lib/api';
import type { StageIoItem, WorkflowMember } from '../lib/api';
import { usePoll } from '../ui';

type ModalState =
  | { loading: true; title: string }
  | { loading: false; title: string; content: string; truncated: boolean };

/** Extract a display label from a work-item detail blob: prefers `detail.name`, falls back to the key. */
function itemLabel(key: string, detail: StageIoItem['detail']): string {
  if (detail && typeof detail.name === 'string' && detail.name) return detail.name;
  return key;
}

function markdownPath(detail: StageIoItem['detail']): string | null {
  return detail && typeof detail.markdown === 'string' ? (detail.markdown as string) : null;
}

/** One row in a decoupled inputs/outputs list — a key + optional name/detail summary,
 *  with a click-to-preview affordance when the item recorded a markdown artifact. */
function StageIoItemRow(
  { runId, item, onOpen }: {
    runId: string;
    item: StageIoItem;
    onOpen: (title: string, contentPromise: Promise<{ content: string; truncated: boolean }>) => void;
  },
) {
  const label = itemLabel(item.itemKey, item.detail);
  const mdPath = markdownPath(item.detail);

  const open = () => {
    const contentPromise = api.workflowRunOutput(runId, item.jobName, item.itemKey)
      .then((o) => ({ content: o.content ?? '', truncated: !!o.truncated }));
    onOpen(label, contentPromise);
  };

  return (
    <li className="stage-io-item">
      <div className="stage-io-item-meta">
        <div className="stage-io-item-key">{item.itemKey}</div>
        {label !== item.itemKey && !mdPath && <div className="stage-io-item-name">{label}</div>}
        {mdPath && (
          <button type="button" className="stage-io-item-link" onClick={open} title={mdPath}>
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

/**
 * Decoupled per-stage inputs/outputs panel — an alternative to the generic
 * joined `IoPanel` for `stock-digest`, whose `stock-digest-build` stage is a
 * genuine many-to-one aggregation (many tickers/sectors → one report) that a
 * single joined "input → output" row can't represent honestly (see the
 * stock-digest.workflow.ts file comment / root CLAUDE.md). Renders one block
 * per DAG member, each showing its OWN inputs (its direct predecessor(s)'
 * ledger rows this run) and OWN outputs (its own ledger rows this run) as two
 * independent lists — no attempt to pair them into rows.
 */
export function StageIoPanel({ runId, members }: { runId: string; members: WorkflowMember[] }) {
  if (members.length === 0) return null;
  return (
    <>
      <h2>Inputs &amp; outputs</h2>
      {members.map((m) => (
        <StageIoBlock key={m.job_name} runId={runId} jobName={m.job_name} />
      ))}
    </>
  );
}
