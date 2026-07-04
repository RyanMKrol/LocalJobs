'use client';

import { useState } from 'react';
import { api } from '../lib/api';
import { Pill } from '../components/Pill';

const CONFIRM_PHRASE = 'DELETE ALL OUTPUT';
const DEFAULT_RUN_ALL_LIMIT = 3;

type ResetAllResult = Awaited<ReturnType<typeof api.resetAllWorkflowsOutput>>;
type RunAllResult = Awaited<ReturnType<typeof api.runAllWorkflows>>;

export default function AdminPage() {
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ResetAllResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [runAllLimit, setRunAllLimit] = useState(DEFAULT_RUN_ALL_LIMIT);
  const [runAllConfirming, setRunAllConfirming] = useState(false);
  const [runAllBusy, setRunAllBusy] = useState(false);
  const [runAllResult, setRunAllResult] = useState<RunAllResult | null>(null);
  const [runAllErr, setRunAllErr] = useState<string | null>(null);

  const canDelete = confirmText === CONFIRM_PHRASE;

  async function deleteAllOutput() {
    if (!canDelete) return;
    setBusy(true);
    setResult(null);
    setErr(null);
    try {
      const r = await api.resetAllWorkflowsOutput();
      setResult(r);
      setConfirmText('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirmRunAll() {
    setRunAllBusy(true);
    setRunAllResult(null);
    setRunAllErr(null);
    try {
      const r = await api.runAllWorkflows(runAllLimit);
      setRunAllResult(r);
      setRunAllConfirming(false);
    } catch (e) {
      setRunAllErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRunAllBusy(false);
    }
  }

  return (
    <>
      <h1>Admin</h1>
      <p className="sub">Fleet-wide, destructive maintenance actions. Use with care.</p>

      <h2>Run everything</h2>
      <div className="panel" style={{ padding: 18 }}>
        <strong>Run all workflows</strong>
        <p className="muted" style={{ fontSize: 13, margin: '4px 0 12px' }}>
          Starts a manual run of <strong>every workflow</strong> at once (including disabled ones),
          each capped to a small number of originating inputs where the workflow supports limiting —
          workflows with no limitable input just run normally/unlimited. This mirrors clicking
          "Run now" on every workflow's own page. It is <strong>not destructive</strong> — nothing is
          deleted — but it does trigger real work, including workflows that make paid/metered API
          calls; those calls are still governed by each service's own spend cap, same as any other
          manual run.
        </p>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
          <label htmlFor="admin-run-all-limit" style={{ fontSize: 13 }}>
            Limit (originating inputs, where supported):
          </label>
          <input
            id="admin-run-all-limit"
            className="mono"
            type="number"
            min={1}
            value={runAllLimit}
            onChange={(e) => setRunAllLimit(Math.max(1, Number(e.target.value) || DEFAULT_RUN_ALL_LIMIT))}
            disabled={runAllBusy || runAllConfirming}
            style={{ width: 80 }}
          />
        </div>

        {!runAllConfirming && (
          <button
            className="btn"
            onClick={() => setRunAllConfirming(true)}
            disabled={runAllBusy}
          >
            Run all workflows
          </button>
        )}

        {runAllConfirming && (
          <div className="panel" style={{ borderLeft: '3px solid var(--yellow, orange)', padding: 12, marginBottom: 12 }}>
            <p style={{ fontSize: 13, margin: '0 0 10px' }}>
              This will start a manual run of every workflow (limit {runAllLimit} input
              {runAllLimit === 1 ? '' : 's'} where supported). Continue?
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={confirmRunAll} disabled={runAllBusy}>
                {runAllBusy ? 'Starting…' : 'Confirm'}
              </button>
              <button
                className="btn"
                onClick={() => setRunAllConfirming(false)}
                disabled={runAllBusy}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {runAllErr && <p style={{ fontSize: 12, color: 'var(--red)', marginTop: 10 }}>{runAllErr}</p>}

        {runAllResult && (
          <div style={{ marginTop: 16 }}>
            <p style={{ fontSize: 13, color: 'var(--green)' }}>
              Started {runAllResult.startedCount} of {runAllResult.totalWorkflows} workflow(s);{' '}
              {runAllResult.skippedCount} skipped. "Started" means the run was dispatched, not that
              it has finished — watch progress on the{' '}
              <a href="/workflows">Workflows page</a>.
            </p>
            <div className="panel">
              <table>
                <thead>
                  <tr>
                    <th>Workflow</th>
                    <th>Status</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {runAllResult.results.map((r) => (
                    <tr key={r.name}>
                      <td>{r.name}</td>
                      <td>
                        <Pill kind={r.status === 'started' ? 'on' : 'off'}>{r.status}</Pill>
                      </td>
                      <td className="muted">
                        {r.status === 'started'
                          ? r.limited
                            ? `limit ${r.limit}`
                            : 'unlimited'
                          : r.reason}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <h2>Danger zone</h2>
      <div className="panel" style={{ borderLeft: '3px solid var(--red)', padding: 18 }}>
        <strong>Delete all workflow output</strong>
        <p className="muted" style={{ fontSize: 13, margin: '4px 0 0' }}>
          This permanently deletes, for <strong>every workflow</strong>:
        </p>
        <ul className="muted" style={{ fontSize: 13, margin: '4px 0' }}>
          <li>Work item ledgers (every workflow re-runs from scratch next time)</li>
          <li>All run history and logs</li>
          <li>Output files (<code>data/out/**</code>) for all workflows</li>
        </ul>
        <p className="muted" style={{ fontSize: 13, margin: '4px 0 8px' }}>
          This will <strong>NOT</strong> touch:
        </p>
        <ul className="muted" style={{ fontSize: 13, margin: '4px 0 12px' }}>
          <li>Input data (<code>data/raw/**</code>) for any workflow</li>
          <li>Workflow settings (schedule, concurrency, enabled)</li>
          <li>Service limits and usage</li>
        </ul>
        <p className="muted" style={{ fontSize: 13, margin: '4px 0 12px' }}>
          Workflows with an active run are skipped rather than reset. Every other workflow
          re-processes everything from scratch on its next run.
        </p>

        <label htmlFor="admin-confirm-input" style={{ display: 'block', fontSize: 13, marginBottom: 6 }}>
          Type <code className="mono">{CONFIRM_PHRASE}</code> to confirm:
        </label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            id="admin-confirm-input"
            className="mono"
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={CONFIRM_PHRASE}
            disabled={busy}
            style={{ flex: '1 1 260px', minWidth: 0 }}
          />
          <button
            className="btn btn-danger"
            onClick={deleteAllOutput}
            disabled={!canDelete || busy}
            title={canDelete ? undefined : `Type "${CONFIRM_PHRASE}" exactly to enable this button`}
          >
            {busy ? 'Deleting…' : 'Delete all workflow output'}
          </button>
        </div>

        {err && <p style={{ fontSize: 12, color: 'var(--red)', marginTop: 10 }}>{err}</p>}

        {result && (
          <div style={{ marginTop: 16 }}>
            <p style={{ fontSize: 13, color: 'var(--green)' }}>
              Reset {result.resetCount} of {result.totalWorkflows} workflow(s); {result.skippedCount} skipped.
            </p>
            <div className="panel">
              <table>
                <thead>
                  <tr>
                    <th>Workflow</th>
                    <th>Status</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {result.results.map((r) => (
                    <tr key={r.name}>
                      <td>{r.name}</td>
                      <td>
                        <span className={`pill ${r.status === 'reset' ? 'on' : 'off'}`}>{r.status}</span>
                      </td>
                      <td className="muted">
                        {r.status === 'reset'
                          ? `${r.itemsDeleted} ledger rows, ${r.runsDeleted} job runs, ${r.wfRunsDeleted} workflow runs, ${r.filesRemoved} output file entries`
                          : r.reason}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
