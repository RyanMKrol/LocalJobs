'use client';

import { api, type BacklogTask } from '../lib/api';
import { usePoll } from '../ui';

function statusPill(t: BacklogTask, isNext: boolean) {
  if (t.status === 'done') {
    return <span className="pill done">✓ done</span>;
  }
  if (isNext) {
    return <span className="pill in-progress">▶ in progress</span>;
  }
  return <span className="pill">{t.status}</span>;
}

function TaskCard({ t, isNext }: { t: BacklogTask; isNext: boolean }) {
  const human = t.gate === 'needs-human' || t.gate === 'gate';
  return (
    <div className="panel" style={{ padding: 14, marginBottom: 8, borderColor: human ? 'var(--accent)' : isNext ? 'rgba(88,166,255,.4)' : undefined }}>
      <div className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span className="mono" style={{ fontWeight: 700 }}>{t.id}</span>
        <strong>{t.title}</strong>
        <div className="spacer" />
        {human && <span className="pill" style={{ background: 'var(--accent)', color: '#fff' }}>🔒 needs human</span>}
        {statusPill(t, isNext)}
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
        <span className="mono">{(t.model ?? 'default').replace('claude-', '')}{t.effort ? `/${t.effort}` : ''}</span>
      </div>
    </div>
  );
}

function findNextEligible(tasks: BacklogTask[]): string | null {
  const doneIds = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));
  const next = tasks.find(
    (t) => t.status !== 'done' && t.gate == null && t.dependsOn.every((dep) => doneIds.has(dep)),
  );
  return next?.id ?? null;
}

export default function Backlog() {
  const { data, error } = usePoll(() => api.backlog(), 5000);
  const tasks = data?.tasks ?? [];
  const buildable = tasks.filter((t) => t.gate == null);
  const human = tasks.filter((t) => t.gate != null);
  const nextId = findNextEligible(tasks);

  return (
    <>
      <h1>Backlog</h1>
      <p className="sub">
        The harness task list (<span className="mono">.harness/TASKS.json</span>), rendered.
        {' '}{tasks.length} task(s) · {buildable.length} harness-buildable · {human.length} need a human. Auto-refreshes.
      </p>
      {error && <p className="muted">⚠ Cannot reach the daemon API ({error}).</p>}
      {data?.error && <p className="muted">⚠ Cannot read the backlog ({data.error}).</p>}

      <h2>🤖 Harness-buildable ({buildable.length})</h2>
      {buildable.length === 0 && <p className="muted">None.</p>}
      {buildable.map((t) => <TaskCard key={t.id} t={t} isNext={t.id === nextId} />)}

      <h2 style={{ marginTop: 28 }}>🔒 Needs a human ({human.length})</h2>
      <p className="sub">The loop skips these — work them manually.</p>
      {human.length === 0 && <p className="muted">None.</p>}
      {human.map((t) => <TaskCard key={t.id} t={t} isNext={false} />)}
    </>
  );
}
