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
}: {
  t: BacklogTask;
  selectable?: boolean;
  checked?: boolean;
  onCheck?: (id: string, val: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const human = t.gate === 'needs-human' || t.gate === 'gate';
  const buildable = t.status !== 'done' && !human;
  const isDone = t.status === 'done';
  const reviewed = t.reviewed === true;

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
        {buildable && <span className="pill buildable" style={{ flexShrink: 0 }}>🤖 buildable</span>}
        {human && <span className="pill human" style={{ flexShrink: 0 }}>🔒 needs human</span>}
        {isDone && (
          <>
            <span className={`pill ${reviewed ? 'reviewed' : 'unreviewed'}`} style={{ flexShrink: 0 }}>
              {reviewed ? '👁 reviewed' : 'not reviewed'}
            </span>
            <span className="pill done" style={{ flexShrink: 0 }}>✓ done</span>
          </>
        )}
      </div>
      {expanded && (
        <div style={{ padding: '8px 14px 12px', borderBottom: '1px solid var(--border)', background: 'var(--panel-2)', borderRadius: '0 0 4px 4px' }}>
          {t.dependsOn && t.dependsOn.length > 0 && (
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
              depends on: <span className="mono">{t.dependsOn.join(', ')}</span>
            </div>
          )}
          <TaskSpec t={t} small />
          {t.tags && t.tags.length > 0 && (
            <div>
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
  const { data, error } = usePoll(() => api.backlog(), 5000, [refreshNonce]);
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkPending, setBulkPending] = useState(false);
  // Non-fatal warning when the review was saved + committed locally but the push
  // to GitHub didn't go through (offline / no remote). The commit still persists.
  const [pushWarning, setPushWarning] = useState<string | null>(null);

  const tasks = data?.tasks ?? [];
  const allDone = tasks.filter((t) => t.status === 'done').sort((a, b) => a.id.localeCompare(b.id));
  const reviewedCount = allDone.filter((t) => t.reviewed === true).length;
  const done = allDone.filter((t) =>
    reviewFilter === 'all' ? true : reviewFilter === 'reviewed' ? t.reviewed === true : t.reviewed !== true,
  );
  const buildable = tasks.filter((t) => t.status !== 'done' && t.gate == null);
  const human = tasks.filter((t) => t.status !== 'done' && t.gate != null);

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
    setRefreshNonce((n) => n + 1);
  };

  return (
    <>
      <div className="row" style={{ alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
        <h1 style={{ margin: 0 }}>Backlog</h1>
      </div>
      <p className="sub">
        The harness task list (<span className="mono">.harness/TASKS.json</span>), rendered.
        {' '}{tasks.length} task(s) · {buildable.length} harness-buildable · {human.length} need a human · {allDone.length} done ({reviewedCount} reviewed). Auto-refreshes.
      </p>
      {error && <p className="muted">⚠ Cannot reach the daemon API ({error}).</p>}
      {data?.error && <p className="muted">⚠ Cannot read the backlog ({data.error}).</p>}
      {pushWarning && <p className="muted" style={{ fontSize: 12 }}>⚠ Review saved locally but not pushed to GitHub ({pushWarning}). It will sync on the next successful push.</p>}

      <div>
        <details open>
          <summary className="section-heading-summary">
            🤖 Harness-buildable ({buildable.length})
          </summary>
          <div className="panel" style={{ padding: '0 14px' }}>
            {buildable.length === 0 && <p className="muted" style={{ padding: '8px 0' }}>None.</p>}
            {buildable.map((t) => <CollapsibleRow key={t.id} t={t} />)}
          </div>
        </details>

        <details open style={{ marginTop: 28 }}>
          <summary className="section-heading-summary">
            🔒 Needs a human ({human.length})
          </summary>
          <p className="sub">The loop skips these — work them manually.</p>
          <div className="panel" style={{ padding: '0 14px' }}>
            {human.length === 0 && <p className="muted" style={{ padding: '8px 0' }}>None.</p>}
            {human.map((t) => <CollapsibleRow key={t.id} t={t} />)}
          </div>
        </details>

        <details style={{ marginTop: 28 }}>
          <summary className="section-heading-summary muted">
            ✅ Done ({allDone.length})
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
              />
            ))}
          </div>
        </details>
      </div>
    </>
  );
}
