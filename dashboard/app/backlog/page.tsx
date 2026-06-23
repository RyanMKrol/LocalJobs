'use client';

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { api, type BacklogTask, type BacklogDefaults } from '../lib/api';
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

type Difficulty = 'easy' | 'medium' | 'hard' | 'very-hard';

function resolveDifficulty(model: string | undefined, effort: string | undefined, defaults: BacklogDefaults | undefined): Difficulty {
  const m = (model ?? defaults?.model ?? '').replace(/^claude-/, '');
  const e = effort ?? defaults?.effort ?? '';
  // Mapping: sonnet@any or @low/medium → easy; opus@high → medium; opus@xhigh → hard; opus@max → very hard
  if (m.includes('opus')) {
    if (e === 'max') return 'very-hard';
    if (e === 'xhigh') return 'hard';
    return 'medium'; // opus@high or unspecified
  }
  return 'easy'; // sonnet or unknown
}

function difficultyPill(t: BacklogTask, defaults: BacklogDefaults | undefined) {
  const d = resolveDifficulty(t.model, t.effort, defaults);
  const labels: Record<Difficulty, string> = { easy: 'easy', medium: 'medium', hard: 'hard', 'very-hard': 'very hard' };
  return <span className={`pill diff-${d}`}>{labels[d]}</span>;
}

function statusPill(t: BacklogTask) {
  if (t.status === 'done') {
    return <span className="pill done">✓ done</span>;
  }
  // Pending is pending. Nothing is "in progress" unless a job is actively running, which
  // TASKS.json does not track — so a not-done task shows its real status. (The DAG view does
  // not single out a "next" task — T076 dropped that concept.)
  return <span className="pill">{t.status}</span>;
}

function TaskCard({ t, defaults }: { t: BacklogTask; defaults: BacklogDefaults | undefined }) {
  const human = t.gate === 'needs-human' || t.gate === 'gate';
  const buildable = t.status !== 'done' && !human;
  return (
    <div className="panel" style={{ padding: 14, marginBottom: 8, borderColor: human ? 'var(--accent)' : buildable ? 'var(--amber)' : undefined }}>
      <div className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span className="mono" style={{ fontWeight: 700 }}>{t.id}</span>
        <strong>{t.title}</strong>
        <div className="spacer" />
        {buildable && <span className="pill buildable">🤖 buildable</span>}
        {human && <span className="pill" style={{ background: 'var(--accent)', color: '#fff' }}>🔒 needs human</span>}
        {difficultyPill(t, defaults)}
        {statusPill(t)}
      </div>
      {t.dependsOn && t.dependsOn.length > 0 && (
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          depends on: <span className="mono">{t.dependsOn.join(', ')}</span>
        </div>
      )}
      <TaskSpec t={t} />
      <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
        {t.tags?.map((tag) => (
          <span key={tag} className="pill" style={{ marginRight: 4 }}>{tag}</span>
        ))}
      </div>
    </div>
  );
}

function DoneRow({ t, onToggleReviewed }: { t: BacklogTask; onToggleReviewed: (t: BacklogTask) => void }) {
  const [expanded, setExpanded] = useState(false);
  const reviewed = t.reviewed === true;
  return (
    <div>
      <div
        className="row done-row"
        style={{ gap: 8, padding: '5px 0', borderBottom: expanded ? 'none' : '1px solid var(--border)', alignItems: 'baseline', flexWrap: 'wrap', cursor: 'pointer', userSelect: 'none' }}
        onClick={() => setExpanded((e) => !e)}
        role="button"
        aria-expanded={expanded}
      >
        <span className="muted" style={{ fontSize: 10, minWidth: 10 }}>{expanded ? '▾' : '▸'}</span>
        <span className="mono" style={{ fontWeight: 700, minWidth: 48 }}>{t.id}</span>
        <span style={{ flex: 1 }}>{t.title}</span>
        <span className={`pill ${reviewed ? 'reviewed' : 'unreviewed'}`} style={{ flexShrink: 0 }}>
          {reviewed ? '👁 reviewed' : 'not reviewed'}
        </span>
        <button
          type="button"
          className="review-toggle"
          style={{ flexShrink: 0 }}
          onClick={(e) => { e.stopPropagation(); onToggleReviewed(t); }}
          title={reviewed ? 'Mark this task as not reviewed' : 'Mark this task as reviewed'}
        >
          {reviewed ? 'Mark not reviewed' : 'Mark as reviewed'}
        </button>
        <span className="pill done" style={{ flexShrink: 0 }}>✓ done</span>
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
  // Non-fatal warning when the review was saved + committed locally but the push
  // to GitHub didn't go through (offline / no remote). The commit still persists.
  const [pushWarning, setPushWarning] = useState<string | null>(null);

  const toggleReviewed = async (t: BacklogTask) => {
    try {
      const res = await api.markReviewed(t.id, !(t.reviewed === true));
      setPushWarning(res.committed && res.pushed === false ? (res.warning ?? 'saved locally, push pending') : null);
    } catch {
      // ignore — the next poll reflects the true file state
    }
    setRefreshNonce((n) => n + 1); // refetch immediately so the pill flips
  };

  const tasks = data?.tasks ?? [];
  const defaults = data?.defaults;
  const allDone = tasks.filter((t) => t.status === 'done').sort((a, b) => a.id.localeCompare(b.id));
  const reviewedCount = allDone.filter((t) => t.reviewed === true).length;
  const done = allDone.filter((t) =>
    reviewFilter === 'all' ? true : reviewFilter === 'reviewed' ? t.reviewed === true : t.reviewed !== true,
  );
  const buildable = tasks.filter((t) => t.status !== 'done' && t.gate == null);
  const human = tasks.filter((t) => t.status !== 'done' && t.gate != null);

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
          {buildable.length === 0 && <p className="muted">None.</p>}
          {buildable.map((t) => <TaskCard key={t.id} t={t} defaults={defaults} />)}
        </details>

        <details open style={{ marginTop: 28 }}>
          <summary className="section-heading-summary">
            🔒 Needs a human ({human.length})
          </summary>
          <p className="sub">The loop skips these — work them manually.</p>
          {human.length === 0 && <p className="muted">None.</p>}
          {human.map((t) => <TaskCard key={t.id} t={t} defaults={defaults} />)}
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
                onClick={() => setReviewFilter(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="panel" style={{ padding: '0 14px' }}>
            {done.length === 0 && <p className="muted" style={{ padding: '8px 0' }}>None{reviewFilter !== 'all' ? ' matching this filter' : ' yet'}.</p>}
            {done.map((t) => <DoneRow key={t.id} t={t} onToggleReviewed={toggleReviewed} />)}
          </div>
        </details>
      </div>
    </>
  );
}
