'use client';

import { useState } from 'react';
import { api } from '../lib/api';

const CONFIRM_PHRASE = 'DELETE ALL OUTPUT';

type ResetAllResult = Awaited<ReturnType<typeof api.resetAllWorkflowsOutput>>;

export default function AdminPage() {
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ResetAllResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

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

  return (
    <>
      <h1>Admin</h1>
      <p className="sub">Fleet-wide, destructive maintenance actions. Use with care.</p>

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
