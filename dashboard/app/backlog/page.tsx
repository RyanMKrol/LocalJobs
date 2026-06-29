'use client';

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { api, type BacklogTask } from '../lib/api';
import { usePoll } from '../ui';

/**
 * Render a task's Markdown spec (## Do / ## Done when, T131) as readable markdown.
 * XSS-safe — react-markdown with no rehype-raw, so any raw HTML is escaped, not
 * executed. Falls back to a muted note when the spec content is unavailable.
 */
function TaskSpec({ t, small }: { t: BacklogTask; small?: boolean }) {
  if (!t.specContent) {
    return <p className="muted" style={{ fontSize: small ? 12 : 13 }}>No spec available{t.spec ? ` (${t.spec})` : ''}.</p>;
  }
  return (
    <div className="task-spec md-body" style={{ fontSize: small ? 13 : 14 }}>
      <ReactMarkdown>{t.specContent}</ReactMarkdown>
    </div>
  );
}

/** Shared compact row that collapses/expands for all three backlog sections. */
function CollapsibleRow({
  t,
  selectable,
  checked,
  onCheck,
  onMarkDone,
  onMarkFailed,
  unmetDeps,
}: {
  t: BacklogTask;
  selectable?: boolean;
  checked?: boolean;
  onCheck?: (id: string, val: boolean) => void;
  onMarkDone?: (id: string) => void;
  onMarkFailed?: (id: string) => void;
  unmetDeps?: string[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [markingDone, setMarkingDone] = useState(false);
  const [markingFailed, setMarkingFailed] = useState(false);
  const human = t.gate === 'needs-human' || t.gate === 'gate';
  const isFailedStatus = t.status === 'failed';   // owner-failed terminal status (T279)
  const buildable = t.status !== 'done' && !isFailedStatus && !human;
  // "done" here means TERMINAL (done OR failed OR human-done) — gates the reviewed/done/failed pills.
  const isDone = t.status === 'done' || isFailedStatus || t.done === true;
  const reviewed = t.reviewed === true;
  const isHumanDone = t.done === true;
  const isFailed = t.failed === true;

  return (
    <div>
      <div
        className={`row done-row${expanded ? ' expanded' : ''}`}
        style={{
          gap: 8,
          padding: '5px 0',
          alignItems: 'baseline',
          flexWrap: 'wrap',
          cursor: 'pointer',
          userSelect: 'none',
        }}
        onClick={() => setExpanded((e) => !e)}
        role="button"
        aria-expanded={expanded}
      >
        {selectable && !reviewed && (
          <input
            type="checkbox"
            checked={checked ?? false}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => { e.stopPropagation(); onCheck?.(t.id, e.target.checked); }}
            aria-label={`Select ${t.id} for bulk review`}
            style={{ flexShrink: 0, cursor: 'pointer' }}
          />
        )}
        {selectable && reviewed && (
          <span style={{ display: 'inline-block', width: 13, flexShrink: 0 }} />
        )}
        <span className="muted" style={{ fontSize: 10, minWidth: 10 }}>{expanded ? '▾' : '▸'}</span>
        <span className="mono" style={{ fontWeight: 700, minWidth: 48 }}>{t.id}</span>
        <span style={{ flex: 1 }}>{t.title}</span>
        {unmetDeps && unmetDeps.length > 0 && (
          <span className="pill dep-waiting" style={{ flexShrink: 0 }}>needs: {unmetDeps.join(', ')}</span>
        )}
        {buildable && !unmetDeps?.length && <span className="pill buildable" style={{ flexShrink: 0 }}>🤖 buildable</span>}
        {human && !isHumanDone && <span className="pill human" style={{ flexShrink: 0 }}>🔒 needs human</span>}
        {human && !isHumanDone && onMarkDone && (
          <button
            type="button"
            className="review-toggle"
            disabled={markingDone}
            style={{ flexShrink: 0 }}
            onClick={async (e) => {
              e.stopPropagation();
              setMarkingDone(true);
              try { await api.markBacklogDone(t.id); } catch { /* ignore — next poll reflects state */ }
              setMarkingDone(false);
              onMarkDone(t.id);
            }}
          >
            {markingDone ? 'Saving…' : 'Mark done'}
          </button>
        )}
        {isDone && (
          <div className="done-status-cluster" onClick={(e) => e.stopPropagation()}>
            <span className={`pill ${reviewed ? 'reviewed' : 'unreviewed'}`}>
              {reviewed ? '👁 reviewed' : 'not reviewed'}
            </span>
            {isFailed ? (
              <span className="pill failed" title={t.failReason ?? undefined}>✗ failed</span>
            ) : (
              <span className="pill done">✓ done</span>
            )}
            {onMarkFailed ? (
              <button
                type="button"
                className="review-toggle"
                disabled={markingFailed}
                onClick={async (e) => {
                  e.stopPropagation();
                  if (!isFailed) {
                    const reason = window.prompt(`Mark ${t.id} as FAILED — what was actually wrong?\n\n(This overturns the recorded success: future tasks of this kind get built with a stronger model and audited more often. It does NOT re-open the task.)`);
                    if (reason === null || !reason.trim()) return;
                    setMarkingFailed(true);
                    try { await api.markBacklogFailed(t.id, true, reason.trim()); } catch { /* ignore — next poll reflects state */ }
                  } else {
                    setMarkingFailed(true);
                    try { await api.markBacklogFailed(t.id, false); } catch { /* ignore */ }
                  }
                  setMarkingFailed(false);
                  onMarkFailed(t.id);
                }}
              >
                {markingFailed ? 'Saving…' : isFailed ? 'Undo fail' : 'Mark failed'}
              </button>
            ) : (
              <span />
            )}
          </div>
        )}
      </div>
      {expanded && (
        <div className="task-expand-body">
          {t.dependsOn && t.dependsOn.length > 0 && (
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
              depends on: <span className="mono">{t.dependsOn.join(', ')}</span>
            </div>
          )}
          <TaskSpec t={t} small />
          {t.worklogContent && (
            <details style={{ marginTop: 10 }}>
              <summary className="muted" style={{ fontSize: 12, cursor: 'pointer', userSelect: 'none' }}>Build log</summary>
              <div className="task-spec md-body" style={{ fontSize: 13, marginTop: 6 }}>
                <ReactMarkdown>{t.worklogContent}</ReactMarkdown>
              </div>
            </details>
          )}
          {t.tags && t.tags.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {t.tags.map((tag) => (
                <span key={tag} className="pill" style={{ marginRight: 4 }}>{tag}</span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type ReviewFilter = 'all' | 'reviewed' | 'not';
const REVIEW_FILTERS: { id: ReviewFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'reviewed', label: 'Reviewed' },
  { id: 'not', label: 'Not reviewed' },
];

export default function Backlog() {
  const [refreshNonce, setRefreshNonce] = useState(0);
  const refresh = () => setRefreshNonce((n) => n + 1);
  const { data, error } = usePoll(() => api.backlog(), 5000, [refreshNonce]);
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkPending, setBulkPending] = useState(false);
  // Non-fatal warning when the review was saved + committed locally but the push
  // to GitHub didn't go through (offline / no remote). The commit still persists.
  const [pushWarning, setPushWarning] = useState<string | null>(null);

  const tasks = data?.tasks ?? [];
  const taskNum = (id: string) => parseInt(id.replace(/^T/, ''), 10) || 0;
  // Terminal tasks (the "Done" section): done OR the owner-failed terminal status (T279, reconciled
  // from the manual-fail overlay) OR human-done. A failed task shows here with its red "failed" pill.
  const allDone = tasks.filter((t) => t.status === 'done' || t.status === 'failed' || t.done === true).sort((a, b) => {
    const aRev = a.reviewed === true ? 1 : 0;
    const bRev = b.reviewed === true ? 1 : 0;
    if (aRev !== bRev) return aRev - bRev;
    return taskNum(a.id) - taskNum(b.id);
  });
  const reviewedCount = allDone.filter((t) => t.reviewed === true).length;
  const done = allDone.filter((t) =>
    reviewFilter === 'all' ? true : reviewFilter === 'reviewed' ? t.reviewed === true : t.reviewed !== true,
  );
  // Build a set of done task ids for quick dep-resolution.
  const doneIds = new Set(tasks.filter((t) => t.status === 'done' || t.done === true).map((t) => t.id));
  // Buildable excludes terminal statuses — a `failed` task is terminal (never re-built), so it must
  // NOT appear as ready/waiting (it would, since gate==null + status!=='done', without this guard).
  const buildable = tasks.filter((t) => t.status !== 'done' && t.status !== 'failed' && t.gate == null);
  // Split buildable into ready (all deps done) and waiting (≥1 dep not done).
  const ready = buildable.filter((t) => (t.dependsOn ?? []).every((dep) => doneIds.has(dep)));
  const waiting = buildable.filter((t) => (t.dependsOn ?? []).some((dep) => !doneIds.has(dep)));
  const human = tasks.filter((t) => t.status !== 'done' && t.status !== 'failed' && t.done !== true && t.gate != null);

  // Unreviewed tasks currently visible in the done section (checkable).
  const unreviewedVisible = done.filter((t) => t.reviewed !== true);
  const allChecked = unreviewedVisible.length > 0 && unreviewedVisible.every((t) => selected.has(t.id));

  const toggleSelectAll = () => {
    if (allChecked) {
      setSelected(new Set());
    } else {
      setSelected(new Set(unreviewedVisible.map((t) => t.id)));
    }
  };

  const toggleOne = (id: string, val: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (val) next.add(id); else next.delete(id);
      return next;
    });
  };

  const markSelectedReviewed = async () => {
    if (selected.size === 0) return;
    setBulkPending(true);
    try {
      const ids = Array.from(selected);
      const res = await api.markReviewedBulk(ids);
      setPushWarning(res.committed && res.pushed === false ? (res.warning ?? 'saved locally, push pending') : null);
      setSelected(new Set());
    } catch {
      // ignore — next poll reflects true state
    }
    setBulkPending(false);
    refresh();
  };

  return (
    <>
      <div className="row" style={{ alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
        <h1 style={{ margin: 0 }}>Backlog</h1>
      </div>
      <p className="sub">
        The harness task list (<span className="mono">.harness/TASKS.json</span>), rendered.
        {' '}{tasks.length} task(s) · {ready.length} ready · {waiting.length} waiting · {human.length} need a human · {allDone.length} done ({reviewedCount} reviewed). Auto-refreshes.
      </p>
      {error && <p className="muted">⚠ Cannot reach the daemon API ({error}).</p>}
      {data?.error && <p className="muted">⚠ Cannot read the backlog ({data.error}).</p>}
      {pushWarning && <p className="muted" style={{ fontSize: 12 }}>⚠ Review saved locally but not pushed to GitHub ({pushWarning}). It will sync on the next successful push.</p>}

      <div>
        <details open>
          <summary className="section-heading-summary">
            🤖 Ready ({ready.length})
          </summary>
          <div className="panel" style={{ padding: '0 14px' }}>
            {ready.length === 0 && <p className="muted" style={{ padding: '8px 0' }}>None.</p>}
            {ready.map((t) => <CollapsibleRow key={t.id} t={t} />)}
          </div>
        </details>

        <details open style={{ marginTop: 28 }}>
          <summary className="section-heading-summary">
            ⏳ Waiting on dependencies ({waiting.length})
          </summary>
          <div className="panel" style={{ padding: '0 14px' }}>
            {waiting.length === 0 && <p className="muted" style={{ padding: '8px 0' }}>None.</p>}
            {waiting.map((t) => {
              const unmet = (t.dependsOn ?? []).filter((dep) => !doneIds.has(dep));
              return <CollapsibleRow key={t.id} t={t} unmetDeps={unmet} />;
            })}
          </div>
        </details>

        <details open style={{ marginTop: 28 }}>
          <summary className="section-heading-summary">
            🔒 Needs a human ({human.length})
          </summary>
          <p className="sub">The loop skips these — work them manually.</p>
          <div className="panel" style={{ padding: '0 14px' }}>
            {human.length === 0 && <p className="muted" style={{ padding: '8px 0' }}>None.</p>}
            {human.map((t) => <CollapsibleRow key={t.id} t={t} onMarkDone={t.gate === 'needs-human' ? refresh : undefined} />)}
          </div>
        </details>

        <details style={{ marginTop: 28 }}>
          <summary className="section-heading-summary muted">
            ✅ Done ({allDone.length} · {reviewedCount} reviewed · {allDone.length - reviewedCount} not reviewed)
          </summary>
          <div className="review-filter-bar">
            <span className="caret-style-label">Show</span>
            {REVIEW_FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                className={`caret-style-btn${reviewFilter === f.id ? ' active' : ''}`}
                onClick={() => { setReviewFilter(f.id); setSelected(new Set()); }}
              >
                {f.label}
              </button>
            ))}
          </div>
          {/* Bulk-review controls: select-all + action button */}
          {unreviewedVisible.length > 0 && (
            <div className="row" style={{ alignItems: 'center', gap: 10, padding: '6px 0 4px', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={toggleSelectAll}
                  aria-label="Select all unreviewed done tasks"
                />
                Select all unreviewed ({unreviewedVisible.length})
              </label>
              {selected.size > 0 && (
                <button
                  type="button"
                  className="review-toggle"
                  disabled={bulkPending}
                  onClick={markSelectedReviewed}
                >
                  {bulkPending ? 'Saving…' : `Mark ${selected.size} as reviewed`}
                </button>
              )}
            </div>
          )}
          <div className="panel" style={{ padding: '0 14px' }}>
            {done.length === 0 && <p className="muted" style={{ padding: '8px 0' }}>None{reviewFilter !== 'all' ? ' matching this filter' : ' yet'}.</p>}
            {done.map((t) => (
              <CollapsibleRow
                key={t.id}
                t={t}
                selectable
                checked={selected.has(t.id)}
                onCheck={toggleOne}
                onMarkFailed={refresh}
              />
            ))}
          </div>
        </details>
      </div>
    </>
  );
}
