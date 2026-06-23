'use client';

import { useState } from 'react';
import { api, type BacklogTask, type BacklogDefaults } from '../lib/api';
import { usePoll, useCaretStyle, CARET_STYLES } from '../ui';

function resolveRung(model: string | undefined, effort: string | undefined, defaults: BacklogDefaults | undefined): string {
  const m = (model ?? defaults?.model ?? 'unknown').replace('claude-', '');
  const e = effort ?? defaults?.effort ?? '';
  return e ? `${m}/${e}` : m;
}

function escalationPath(t: BacklogTask, defaults: BacklogDefaults | undefined): string {
  const rungs: string[] = [];
  rungs.push(resolveRung(t.model, t.effort, defaults));
  const escalation = t.escalation ?? defaults?.escalation ?? [];
  for (const rung of escalation) {
    rungs.push(resolveRung(rung.model, rung.effort, defaults));
  }
  return rungs.join(' → ');
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
  const ladder = escalationPath(t, defaults);
  return (
    <div className="panel" style={{ padding: 14, marginBottom: 8, borderColor: human ? 'var(--accent)' : undefined }}>
      <div className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span className="mono" style={{ fontWeight: 700 }}>{t.id}</span>
        <strong>{t.title}</strong>
        <div className="spacer" />
        {human && <span className="pill" style={{ background: 'var(--accent)', color: '#fff' }}>🔒 needs human</span>}
        {statusPill(t)}
      </div>
      {t.dependsOn && t.dependsOn.length > 0 && (
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          depends on: <span className="mono">{t.dependsOn.join(', ')}</span>
        </div>
      )}
      <p style={{ margin: '8px 0 4px', lineHeight: 1.5 }}>{t.do}</p>
      <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
        <strong>Done when:</strong> {t.doneWhen}
      </div>
      <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
        {t.tags?.map((tag) => (
          <span key={tag} className="pill" style={{ marginRight: 4 }}>{tag}</span>
        ))}
        <span className="mono" title="escalation path">{ladder}</span>
      </div>
    </div>
  );
}

function DoneRow({ t }: { t: BacklogTask }) {
  const [expanded, setExpanded] = useState(false);
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
        <span className="pill done" style={{ flexShrink: 0 }}>✓ done</span>
      </div>
      {expanded && (
        <div style={{ padding: '8px 14px 12px', borderBottom: '1px solid var(--border)', background: 'var(--panel-2)', borderRadius: '0 0 4px 4px' }}>
          {t.dependsOn && t.dependsOn.length > 0 && (
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
              depends on: <span className="mono">{t.dependsOn.join(', ')}</span>
            </div>
          )}
          <p style={{ margin: '0 0 6px', fontSize: 13, lineHeight: 1.5 }}>{t.do}</p>
          <div className="muted" style={{ fontSize: 12, lineHeight: 1.5, marginBottom: 6 }}>
            <strong>Done when:</strong> {t.doneWhen}
          </div>
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

export default function Backlog() {
  const { data, error } = usePoll(() => api.backlog(), 5000);
  const [caretStyle, setCaretStyle] = useCaretStyle();

  const tasks = data?.tasks ?? [];
  const defaults = data?.defaults;
  const done = tasks.filter((t) => t.status === 'done').sort((a, b) => a.id.localeCompare(b.id));
  const buildable = tasks.filter((t) => t.status !== 'done' && t.gate == null);
  const human = tasks.filter((t) => t.status !== 'done' && t.gate != null);

  return (
    <>
      <div className="row" style={{ alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
        <h1 style={{ margin: 0 }}>Backlog</h1>
        <div className="spacer" />
        <div className="caret-style-bar" style={{ margin: 0 }}>
          <span className="caret-style-label">Caret</span>
          {CARET_STYLES.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`caret-style-btn${caretStyle === s.id ? ' active' : ''}`}
              onClick={() => setCaretStyle(s.id)}
              title={s.hint}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <p className="sub">
        The harness task list (<span className="mono">.harness/TASKS.json</span>), rendered.
        {' '}{tasks.length} task(s) · {buildable.length} harness-buildable · {human.length} need a human · {done.length} done. Auto-refreshes.
      </p>
      {error && <p className="muted">⚠ Cannot reach the daemon API ({error}).</p>}
      {data?.error && <p className="muted">⚠ Cannot read the backlog ({data.error}).</p>}

      <div className={`caret-${caretStyle}`}>
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
            ✅ Done ({done.length})
          </summary>
          <div className="panel" style={{ padding: '0 14px' }}>
            {done.length === 0 && <p className="muted" style={{ padding: '8px 0' }}>None yet.</p>}
            {done.map((t) => <DoneRow key={t.id} t={t} />)}
          </div>
        </details>
      </div>
    </>
  );
}
