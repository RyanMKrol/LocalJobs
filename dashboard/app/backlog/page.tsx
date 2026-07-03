'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, type BacklogTask } from '../lib/api';
import { usePoll } from '../ui';
import { Pill } from '../components/Pill';

/**
 * Aggregated build-attempt failure history for a task (`.harness/ledgers/failures.jsonl`, T294).
 * Not yet part of the shared `BacklogTask` type (out of this task's scope) — read it
 * defensively off the raw API payload instead.
 */
interface TaskBuildFailures {
  count: number;
  latestKind: string;
  latestDetail: string;
  latestAt: string;
}

function getBuildFailures(t: BacklogTask): TaskBuildFailures | undefined {
  return (t as BacklogTask & { buildFailures?: TaskBuildFailures }).buildFailures;
}

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
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{t.specContent}</ReactMarkdown>
    </div>
  );
}

/** A single clickable dependency id chip that scrolls to and expands the referenced task. */
function DepIdLink({ id, onOpen }: { id: string; onOpen: (id: string) => void }) {
  return (
    <button
      type="button"
      className="dep-id-link mono"
      onClick={(e) => { e.stopPropagation(); onOpen(id); }}
      title={`Jump to ${id}`}
    >
      {id}
    </button>
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
  forceExpanded,
  highlighted,
  onOpenTask,
}: {
  t: BacklogTask;
  selectable?: boolean;
  checked?: boolean;
  onCheck?: (id: string, val: boolean, shiftKey?: boolean) => void;
  onMarkDone?: (id: string) => void;
  onMarkFailed?: (id: string) => void;
  unmetDeps?: string[];
  forceExpanded?: boolean;
  highlighted?: boolean;
  onOpenTask?: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [markingDone, setMarkingDone] = useState(false);
  const [markingFailed, setMarkingFailed] = useState(false);
  const shiftKeyRef = useRef(false);
  const human = t.gate === 'needs-human' || t.gate === 'gate';
  const isFailedStatus = t.status === 'failed';   // owner-failed terminal status (T279)
  const buildable = t.status !== 'done' && !isFailedStatus && !human;
  // "done" here means TERMINAL (done OR failed OR human-done) — gates the reviewed/done/failed pills.
  const isDone = t.status === 'done' || isFailedStatus || t.done === true;
  const reviewed = t.reviewed === true;
  const isHumanDone = t.done === true;
  const isFailed = t.failed === true;
  const buildFailures = getBuildFailures(t);

  // When the parent signals this row should open (dependency navigation), expand it.
  useEffect(() => {
    if (forceExpanded) setExpanded(true);
  }, [forceExpanded]);

  return (
    <div id={`task-${t.id}`} className={highlighted ? 'task-row-highlight' : undefined}>
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
            onClick={(e) => { e.stopPropagation(); shiftKeyRef.current = e.shiftKey; }}
            onChange={(e) => { e.stopPropagation(); onCheck?.(t.id, e.target.checked, shiftKeyRef.current); }}
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
          <Pill kind="dep-waiting" style={{ flexShrink: 0 }}>
            needs:{' '}
            {unmetDeps.map((dep, i) => (
              <span key={dep}>
                {i > 0 && ', '}
                {onOpenTask
                  ? <DepIdLink id={dep} onOpen={onOpenTask} />
                  : <span className="mono">{dep}</span>
                }
              </span>
            ))}
          </Pill>
        )}
        {buildable && !unmetDeps?.length && <Pill kind="buildable" style={{ flexShrink: 0 }}>🤖 buildable</Pill>}
        {human && !isHumanDone && <Pill kind="human" style={{ flexShrink: 0 }}>🔒 needs human</Pill>}
        {!isDone && buildFailures && (
          <Pill
            kind="blocked"
            style={{ flexShrink: 0 }}
            title={`${buildFailures.latestKind}: ${buildFailures.latestDetail}`}
          >
            ⚠ {buildFailures.count} failed attempt{buildFailures.count === 1 ? '' : 's'}
          </Pill>
        )}
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
            <Pill kind={reviewed ? 'reviewed' : 'unreviewed'}>
              {reviewed ? '👁 reviewed' : 'not reviewed'}
            </Pill>
            {isFailed ? (
              <Pill kind="failed" title={t.failReason ?? undefined}>✗ failed</Pill>
            ) : (
              <Pill kind="done">✓ done</Pill>
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
              depends on:{' '}
              {t.dependsOn.map((dep, i) => (
                <span key={dep}>
                  {i > 0 && ', '}
                  {onOpenTask
                    ? <DepIdLink id={dep} onOpen={onOpenTask} />
                    : <span className="mono">{dep}</span>
                  }
                </span>
              ))}
            </div>
          )}
          <TaskSpec t={t} small />
          {t.worklogContent && (
            <details style={{ marginTop: 10 }}>
              <summary className="muted" style={{ fontSize: 12, cursor: 'pointer', userSelect: 'none' }}>Build log</summary>
              <div className="task-spec md-body" style={{ fontSize: 13, marginTop: 6 }}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{t.worklogContent}</ReactMarkdown>
              </div>
            </details>
          )}
          {t.tags && t.tags.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {t.tags.map((tag) => (
                <Pill key={tag} style={{ marginRight: 4 }}>{tag}</Pill>
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
  const [lastClickedId, setLastClickedId] = useState<string | null>(null);
  const [bulkPending, setBulkPending] = useState(false);
  // Non-fatal warning when the review was saved + committed locally but the push
  // to GitHub didn't go through (offline / no remote). The commit still persists.
  const [pushWarning, setPushWarning] = useState<string | null>(null);

  // Dependency navigation: the id of the task that should be scrolled-to + expanded.
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);

  const openTask = useCallback((id: string) => {
    setOpenTaskId(id);
    setHighlightId(id);
    // Defer to next paint so any state updates (section open, row expand) can render first.
    setTimeout(() => {
      const el = document.getElementById(`task-${id}`);
      if (el) {
        // Expand any closed <details> ancestors so the row is visible.
        let node: Element | null = el.parentElement;
        while (node) {
          if (node instanceof HTMLDetailsElement && !node.open) node.open = true;
          node = node.parentElement;
        }
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      // Clear highlight after animation finishes.
      setTimeout(() => setHighlightId(null), 1600);
    }, 50);
  }, []);

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
  // Lookup by id (covers tasks only referenced as a dependency) so we can inspect a dep's own gate.
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  // Buildable excludes terminal statuses — a `failed` task is terminal (never re-built), so it must
  // NOT appear as ready/waiting (it would, since gate==null + status!=='done', without this guard).
  const buildable = tasks.filter((t) => t.status !== 'done' && t.status !== 'failed' && t.gate == null);

  // Walk a task's FULL transitive dependency chain and collect the ids of any not-yet-resolved
  // human-gated task (`gate === 'needs-human' | 'gate'`) reachable anywhere in it — not just direct
  // deps. Memoized (tasks form a DAG; a `seen` guard also protects against an accidental cycle).
  // A task is only genuinely blocked-on-a-human if a gated task sits somewhere upstream; being
  // blocked solely by an ordinary buildable (gate==null) task is NOT a human blocker — the harness
  // will get to that blocker on its own (T293 follow-up to T283: those were being hidden entirely).
  const transitiveHumanBlockersCache = new Map<string, string[]>();
  function transitiveHumanBlockers(id: string, seen: Set<string> = new Set()): string[] {
    const cached = transitiveHumanBlockersCache.get(id);
    if (cached) return cached;
    if (seen.has(id)) return []; // cycle guard — shouldn't happen, TASKS.json is a validated DAG
    seen.add(id);
    const t = taskById.get(id);
    const blockers: string[] = [];
    for (const dep of t?.dependsOn ?? []) {
      if (doneIds.has(dep)) continue; // resolved — not a blocker
      const depTask = taskById.get(dep);
      if (depTask?.gate != null) blockers.push(dep); // direct human-gated blocker
      else blockers.push(...transitiveHumanBlockers(dep, seen));
    }
    transitiveHumanBlockersCache.set(id, blockers);
    return blockers;
  }

  // Ready = buildable AND no human-gated task anywhere upstream (whether directly depended on or
  // several hops away) — this includes tasks with unmet deps, as long as every one of those deps
  // (transitively) resolves without a human. Waiting = buildable but blocked, somewhere upstream, by
  // an unresolved human-gated task.
  const ready = buildable.filter((t) => transitiveHumanBlockers(t.id).length === 0);
  const waiting = buildable.filter((t) => transitiveHumanBlockers(t.id).length > 0);
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

  const toggleOne = (id: string, val: boolean, shiftKey?: boolean) => {
    const visibleIds = unreviewedVisible.map((t) => t.id);
    if (shiftKey && lastClickedId != null && visibleIds.includes(lastClickedId)) {
      const fromIdx = visibleIds.indexOf(lastClickedId);
      const toIdx = visibleIds.indexOf(id);
      const [start, end] = fromIdx <= toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
      setSelected((prev) => {
        const next = new Set(prev);
        for (const rangeId of visibleIds.slice(start, end + 1)) next.add(rangeId);
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        if (val) next.add(id); else next.delete(id);
        return next;
      });
    }
    setLastClickedId(id);
  };

  const markSelectedReviewed = async () => {
    if (selected.size === 0) return;
    setBulkPending(true);
    try {
      const ids = Array.from(selected);
      const res = await api.markReviewedBulk(ids);
      setPushWarning(res.committed && res.pushed === false ? (res.warning ?? 'saved locally, push pending') : null);
      setSelected(new Set());
      setLastClickedId(null);
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
        The harness task list (<span className="mono">.harness/tracking/TASKS.json</span>), rendered.
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
          <p className="sub">
            Everything the harness can build with no human involved — either right now, or once an
            earlier, equally-buildable task in its chain lands.
          </p>
          <div className="panel" style={{ padding: '0 14px' }}>
            {ready.length === 0 && <p className="muted" style={{ padding: '8px 0' }}>None.</p>}
            {ready.map((t) => {
              const unmet = (t.dependsOn ?? []).filter((dep) => !doneIds.has(dep));
              return (
                <CollapsibleRow
                  key={t.id}
                  t={t}
                  unmetDeps={unmet}
                  forceExpanded={openTaskId === t.id}
                  highlighted={highlightId === t.id}
                  onOpenTask={openTask}
                />
              );
            })}
          </div>
        </details>

        <details open style={{ marginTop: 28 }}>
          <summary className="section-heading-summary">
            ⏳ Waiting on Human Tasks ({waiting.length})
          </summary>
          <div className="panel" style={{ padding: '0 14px' }}>
            {waiting.length === 0 && <p className="muted" style={{ padding: '8px 0' }}>None.</p>}
            {waiting.map((t) => {
              const unmet = transitiveHumanBlockers(t.id);
              return (
                <CollapsibleRow
                  key={t.id}
                  t={t}
                  unmetDeps={unmet}
                  forceExpanded={openTaskId === t.id}
                  highlighted={highlightId === t.id}
                  onOpenTask={openTask}
                />
              );
            })}
          </div>
        </details>

        <details open style={{ marginTop: 28 }}>
          <summary className="section-heading-summary">
            🔒 Human Tasks ({human.length})
          </summary>
          <p className="sub">The loop skips these — work them manually.</p>
          <div className="panel" style={{ padding: '0 14px' }}>
            {human.length === 0 && <p className="muted" style={{ padding: '8px 0' }}>None.</p>}
            {human.map((t) => (
              <CollapsibleRow
                key={t.id}
                t={t}
                onMarkDone={t.gate === 'needs-human' ? refresh : undefined}
                forceExpanded={openTaskId === t.id}
                highlighted={highlightId === t.id}
                onOpenTask={openTask}
              />
            ))}
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
                onClick={() => { setReviewFilter(f.id); setSelected(new Set()); setLastClickedId(null); }}
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
                forceExpanded={openTaskId === t.id}
                highlighted={highlightId === t.id}
                onOpenTask={openTask}
              />
            ))}
          </div>
        </details>
      </div>
    </>
  );
}
