'use client';

import { use, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { DagFlow } from '../../components/DagFlow';
import { MissingSeasonsManager } from '../../components/MissingSeasonsManager';
import { MovieGapsManager } from '../../components/MovieGapsManager';
import { MovieRecsManager } from '../../components/MovieRecsManager';
import { Pill } from '../../components/Pill';
import { RunButton } from '../../components/RunButton';
import { TvRecsManager } from '../../components/TvRecsManager';
import { WorkflowOutputSection } from '../../components/WorkflowOutputSection';
import { api } from '../../lib/api';
import { CronBadge, fmtDuration, fmtRelative, fmtTime, statusLabel, usePoll } from '../../ui';

/** Workflow names that show the Missing seasons section. */
const MISSING_SEASONS_WORKFLOWS = new Set(['missing-tv-seasons']);

/**
 * Workflows that have a dedicated, workflow-specific output manager component
 * (MovieRecsManager, MovieGapsManager, MissingSeasonsManager). The generic
 * WorkflowOutputSection is rendered for all OTHER workflows (T205).
 */
const WORKFLOWS_WITH_SPECIFIC_MANAGERS = new Set([
  'movie-recommendations',
  'missing-tv-seasons',
  'tv-recommendations',
  'missing-movies',
]);

export default function WorkflowDetail({ params }: { params: Promise<{ name: string }> }) {
  const { name } = use(params);
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState('');
  const busyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (busyTimerRef.current) clearTimeout(busyTimerRef.current); }, []);
  const { data, error } = usePoll(() => api.workflow(name), 3000, [name]);
  const p = data?.workflow;
  const runs = p?.runs ?? [];

  // Reset (clear output data) state.
  const [resetting, setResetting] = useState(false);
  const [resetResult, setResetResult] = useState<string | null>(null);
  const [resetErr, setResetErr] = useState<string | null>(null);

  async function resetOutput() {
    const msg =
      `Clear all output data for "${name}"?\n\n` +
      `This permanently deletes:\n` +
      `  • Work item ledger (re-runs from scratch next time)\n` +
      `  • All run history and logs\n` +
      `  • Output files (data/out/**)\n\n` +
      `This will NOT touch:\n` +
      `  • Input data (data/raw/**)\n` +
      `  • Workflow settings (schedule, concurrency, enabled)\n\n` +
      `The workflow will re-process everything from scratch on the next run.`;
    if (!confirm(msg)) return;
    setResetting(true);
    setResetResult(null);
    setResetErr(null);
    try {
      const r = await api.resetWorkflowOutput(name);
      setResetResult(`Cleared: ${r.itemsDeleted} ledger rows, ${r.runsDeleted} job runs, ${r.wfRunsDeleted} workflow runs, ${r.filesRemoved} output file entries.`);
    } catch (e) {
      setResetErr(e instanceof Error ? e.message : String(e));
    } finally {
      setResetting(false);
    }
  }

  // Inline schedule editor (T135).
  const [editingSchedule, setEditingSchedule] = useState(false);
  const [scheduleDraft, setScheduleDraft] = useState('');
  const [scheduleErr, setScheduleErr] = useState<string | null>(null);
  const [savingSchedule, setSavingSchedule] = useState(false);

  function startEditSchedule() {
    setScheduleDraft(p?.schedule ?? '');
    setScheduleErr(null);
    setEditingSchedule(true);
  }
  function cancelEditSchedule() {
    setEditingSchedule(false);
    setScheduleErr(null);
  }
  async function saveSchedule() {
    setSavingSchedule(true);
    setScheduleErr(null);
    try {
      await api.updateWorkflowSchedule(name, scheduleDraft);
      // The 3s poll refetches the workflow, so the CronBadge + Next run update on
      // the next tick; close the editor immediately on success.
      setEditingSchedule(false);
    } catch (e) {
      setScheduleErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingSchedule(false);
    }
  }

  // Inline max-concurrency editor (T169/T201) — same affordance as the schedule editor.
  // T201 adds an "Unlimited" toggle: when on, persists sentinel 0 (no cap); when off, the
  // number input applies. effective_max_concurrency === 0 means unlimited.
  const [editingConc, setEditingConc] = useState(false);
  const [concDraft, setConcDraft] = useState('');
  const [concUnlimited, setConcUnlimited] = useState(false);
  const [concErr, setConcErr] = useState<string | null>(null);
  const [savingConc, setSavingConc] = useState(false);

  function startEditConc() {
    const eff = p?.effective_max_concurrency ?? 0;
    const isUnlim = eff === 0;
    setConcUnlimited(isUnlim);
    setConcDraft(isUnlim ? '' : String(eff));
    setConcErr(null);
    setEditingConc(true);
  }
  function cancelEditConc() {
    setEditingConc(false);
    setConcErr(null);
  }
  async function saveConc() {
    setSavingConc(true);
    setConcErr(null);
    try {
      await api.updateWorkflowConcurrency(name, concUnlimited ? 0 : Number(concDraft));
      // The 3s poll refetches, so the displayed value updates on the next tick.
      setEditingConc(false);
    } catch (e) {
      setConcErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingConc(false);
    }
  }

  async function run() {
    setBusy(true);
    try { await api.runWorkflow(name, limit ? Number(limit) : undefined); } finally { busyTimerRef.current = setTimeout(() => setBusy(false), 1200); }
  }
  async function toggle() { if (p) await api.toggleWorkflow(name, p.enabled === 0); }
  async function toggleNotify() { if (p) await api.updateWorkflowNotify(name, !p.effective_notify_enabled); }
  async function toggleCertified() { if (p) await api.updateWorkflowCertified(name, !p.certified); }

  return (
    <>
      <p className="muted"><Link href="/workflows">← Workflows</Link></p>
      {error && <p className="muted">⚠ Cannot reach the daemon API ({error}).</p>}
      <div className="row" style={{ gap: 20 }}>
        <h1 style={{ margin: 0 }}>{name}</h1>
        {p?.certified ? <Pill kind="certified">🏅 Certified</Pill> : null}
        <div className="spacer" />
        {p?.limitable && (
          <div className="run-limit-control">
            <label htmlFor="run-limit" className="run-limit-label">Limit</label>
            <input
              id="run-limit"
              className="mono limit-input"
              type="number"
              min={1}
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder="all"
              title="Limit this run to N originating inputs (blank = all). All fan-out of the selected inputs runs."
            />
          </div>
        )}
        <RunButton isRunning={p?.last_run?.status === 'running'} busy={busy} onClick={run} />
      </div>
      <p className="sub wf-desc">{p?.description}</p>

      <div className="panel" style={{ padding: 18, marginBottom: 8 }}>
        <div className="kv">
          <div className="k">Schedule</div>
          <div>
            {editingSchedule ? (
              <div className="schedule-edit">
                <input
                  className="mono schedule-input"
                  type="text"
                  value={scheduleDraft}
                  onChange={(e) => setScheduleDraft(e.target.value)}
                  placeholder="cron (blank = manual-only)"
                  autoFocus
                  onKeyDown={(e) => { if (e.key === 'Enter') saveSchedule(); if (e.key === 'Escape') cancelEditSchedule(); }}
                />
                <button className="btn btn-sm" onClick={saveSchedule} disabled={savingSchedule}>
                  {savingSchedule ? 'Saving…' : 'Save'}
                </button>
                <button className="btn btn-sm btn-ghost" onClick={cancelEditSchedule} disabled={savingSchedule}>Cancel</button>
                {scheduleErr && <span className="schedule-err">{scheduleErr}</span>}
              </div>
            ) : (
              <span className="schedule-view">
                <span className="mono" style={{ whiteSpace: 'nowrap' }}>
                  {p?.schedule ? <CronBadge expr={p.schedule} /> : 'manual-only'}
                </span>
                <span className="schedule-edit-link" onClick={startEditSchedule}>Edit</span>
              </span>
            )}
          </div>
          <div className="k">Enabled</div>
          <div>
            <span className="toggle" onClick={toggle}>
              <input type="checkbox" checked={!!p?.enabled} readOnly /> {p?.enabled ? 'enabled' : 'disabled'} (click to toggle)
            </span>
          </div>
          <div className="k">Max concurrency</div>
          <div>
            {editingConc ? (
              <div className="schedule-edit">
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={concUnlimited}
                    onChange={(e) => setConcUnlimited(e.target.checked)}
                  />
                  Unlimited
                </label>
                <input
                  className="mono schedule-input"
                  type="number"
                  min={1}
                  step={1}
                  value={concDraft}
                  onChange={(e) => setConcDraft(e.target.value)}
                  placeholder="≥ 1"
                  disabled={concUnlimited}
                  autoFocus={!concUnlimited}
                  onKeyDown={(e) => { if (e.key === 'Enter') saveConc(); if (e.key === 'Escape') cancelEditConc(); }}
                />
                <button className="btn btn-sm" onClick={saveConc} disabled={savingConc}>
                  {savingConc ? 'Saving…' : 'Save'}
                </button>
                <button className="btn btn-sm btn-ghost" onClick={cancelEditConc} disabled={savingConc}>Cancel</button>
                {concErr && <span className="schedule-err">{concErr}</span>}
              </div>
            ) : (
              <span className="schedule-view">
                <span className="mono" style={{ whiteSpace: 'nowrap' }}>
                  {p?.effective_max_concurrency === 0 ? 'Unlimited' : (p?.effective_max_concurrency ?? '—')}
                  {p?.max_concurrency_overridden ? '' : ' (default)'}
                </span>
                <span className="schedule-edit-link" onClick={startEditConc}>Edit</span>
              </span>
            )}
          </div>
          <div className="k">Notifications</div>
          <div>
            <span className="toggle" onClick={toggleNotify}>
              <input type="checkbox" checked={!!p?.effective_notify_enabled} readOnly /> {p?.effective_notify_enabled ? 'notifications on' : 'notifications off'} (click to toggle)
            </span>
          </div>
          <div className="k">Certified</div>
          <div>
            <span className="toggle" onClick={toggleCertified}>
              <input type="checkbox" checked={!!p?.certified} readOnly /> {p?.certified ? 'certified ✓' : 'not certified'} (click to {p?.certified ? 'un-certify' : 'certify'})
            </span>
          </div>
          <div className="k">Next run</div><div className="muted">{p?.next_run ? fmtTime(p.next_run) : '—'}</div>
          <div className="k">Stuck items</div><div style={{ color: p?.stuck ? 'var(--red)' : undefined }}>{p?.stuck ?? 0}</div>
        </div>
      </div>

      <h2>Graph</h2>
      <div className="panel dag-panel">{p && <DagFlow members={p.jobs} structuralGates={p.gates} workflowName={name} from={`/workflows/${name}`} />}</div>

      <h2>Runs</h2>
      <div className="panel">
        <table>
          <thead><tr><th>Status</th><th>Trigger</th><th>Started</th><th>Duration</th><th></th></tr></thead>
          <tbody>
            {runs.length === 0 && <tr><td colSpan={5} className="muted">No runs yet.</td></tr>}
            {runs.map((r) => (
              <tr key={r.id}>
                <td><span className={`badge ${r.status}`}>{statusLabel(r.status)}</span></td>
                <td className="muted">{r.trigger}</td>
                <td className="muted">{fmtRelative(r.started_at)}</td>
                <td className="mono">{fmtDuration(r.duration_ms)}</td>
                <td><Link href={`/workflow-runs/${r.id}`}>details →</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {name === 'movie-recommendations' && (
        <>
          <h2>Output</h2>
          <MovieRecsManager />
        </>
      )}
      {name === 'missing-movies' && (
        <>
          <h2>Output</h2>
          <MovieGapsManager />
        </>
      )}
      {MISSING_SEASONS_WORKFLOWS.has(name) && <MissingSeasonsManager />}
      {name === 'tv-recommendations' && <TvRecsManager />}
      {!WORKFLOWS_WITH_SPECIFIC_MANAGERS.has(name) && <WorkflowOutputSection workflowName={name} />}

      <h2>Danger zone</h2>
      <div className="panel" style={{ borderLeft: '3px solid var(--red)', padding: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <strong>Clear output data</strong>
            <p className="muted" style={{ fontSize: 13, margin: '4px 0 0' }}>
              Deletes run history, the work item ledger, and output files (<code>data/out/**</code>).
              Input data (<code>data/raw</code>), settings, and service limits are preserved.
              The workflow re-processes everything from scratch on the next run.
            </p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
            <button
              className="btn btn-danger"
              onClick={resetOutput}
              disabled={resetting || p?.last_run?.status === 'running'}
              title={p?.last_run?.status === 'running' ? 'Cannot reset while a run is in progress' : undefined}
            >
              {resetting ? 'Clearing…' : 'Clear output data'}
            </button>
            {resetResult && <span style={{ fontSize: 12, color: 'var(--green)' }}>{resetResult}</span>}
            {resetErr && <span style={{ fontSize: 12, color: 'var(--red)' }}>{resetErr}</span>}
          </div>
        </div>
      </div>
    </>
  );
}
