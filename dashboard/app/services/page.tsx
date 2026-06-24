'use client';

import { useState } from 'react';
import { api, type Service } from '../lib/api';
import { usePoll } from '../ui';

function Bar({ used, cap }: { used: number; cap: number | null }) {
  if (cap == null) return <span className="muted">no limit</span>;
  const pct = Math.min(100, (used / cap) * 100);
  const cls = pct >= 100 ? 'full' : pct >= 80 ? 'warn' : '';
  return (
    <div>
      <div className="mono" style={{ fontSize: 12 }}>{used} / {cap}</div>
      <div className="ubar"><span className={cls} style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

// blank input ⇄ null ("no throttle / no cap")
const toField = (v: number | null) => (v == null ? '' : String(v));
const parseField = (s: string): number | null => {
  const t = s.trim();
  if (t === '') return null;
  const n = Number(t);
  return n;
};
const validField = (s: string): boolean => {
  const n = parseField(s);
  return n === null || (Number.isInteger(n) && n >= 0);
};

export default function Services() {
  const { data, error } = usePoll(() => api.services(), 3000);
  const services = [...(data?.services ?? [])].sort(
    (a, b) => (a.paid ? 1 : 0) - (b.paid ? 1 : 0) || a.name.localeCompare(b.name)
  );

  // The row currently being edited, plus its draft values (kept local so polling
  // doesn't clobber typing).
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ rate: '', daily: '', monthly: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function startEdit(s: Service) {
    setEditing(s.name);
    setErr(null);
    setDraft({
      rate: toField(s.rate_per_minute),
      daily: toField(s.daily_cap),
      monthly: toField(s.monthly_cap),
    });
  }

  async function save(name: string) {
    if (!validField(draft.rate) || !validField(draft.daily) || !validField(draft.monthly)) {
      setErr('Each limit must be a non-negative whole number, or blank for no limit.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.updateServiceLimits(name, {
        rate_per_minute: parseField(draft.rate),
        daily_cap: parseField(draft.daily),
        monthly_cap: parseField(draft.monthly),
      });
      setEditing(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'save failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Services</h1>
      <p className="sub">Shared external dependencies with cross-job rate limits + quotas. Auto-refreshes. Edit a limit to override the code default — overrides are preserved across daemon restarts / code-sync.</p>
      {error && <p className="muted">⚠ Cannot reach the daemon API ({error}).</p>}
      {err && <p className="muted" style={{ color: 'var(--red)' }}>⚠ {err}</p>}
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Service</th><th>Rate / min</th><th>Rate / day</th><th>Rate / month</th><th></th>
            </tr>
          </thead>
          <tbody>
            {services.length === 0 && <tr><td colSpan={5} className="muted">No services defined.</td></tr>}
            {services.map((s) => {
              const isEditing = editing === s.name;
              return (
                <tr key={s.name}>
                  <td>
                    <strong>{s.name}</strong> {s.paid ? <span className="pill paid">paid</span> : <span className="pill free">free</span>}
                    {s.limits_overridden ? <span className="pill" title="Limits edited from the dashboard; preserved across code-sync"> edited</span> : null}
                    <div className="muted" style={{ fontSize: 12 }}>{s.description}</div>
                  </td>
                  {isEditing ? (
                    <>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <input type="text" className="mono limit-input" value={draft.rate} placeholder="no limit" onChange={(e) => setDraft((d) => ({ ...d, rate: e.target.value }))} />
                        {draft.rate !== '' && <button className="btn secondary" style={{ marginLeft: 4, padding: '1px 5px', fontSize: 11 }} title="Set to no limit" onClick={() => setDraft((d) => ({ ...d, rate: '' }))}>✕</button>}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <input type="text" className="mono limit-input" value={draft.daily} placeholder="no limit" onChange={(e) => setDraft((d) => ({ ...d, daily: e.target.value }))} />
                        {draft.daily !== '' && <button className="btn secondary" style={{ marginLeft: 4, padding: '1px 5px', fontSize: 11 }} title="Set to no limit" onClick={() => setDraft((d) => ({ ...d, daily: '' }))}>✕</button>}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <input type="text" className="mono limit-input" value={draft.monthly} placeholder="no limit" onChange={(e) => setDraft((d) => ({ ...d, monthly: e.target.value }))} />
                        {draft.monthly !== '' && <button className="btn secondary" style={{ marginLeft: 4, padding: '1px 5px', fontSize: 11 }} title="Set to no limit" onClick={() => setDraft((d) => ({ ...d, monthly: '' }))}>✕</button>}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button className="btn" onClick={() => save(s.name)} disabled={busy}>{busy ? 'Saving…' : '✓ Save'}</button>{' '}
                        <button className="btn secondary" onClick={() => setEditing(null)} disabled={busy}>Cancel</button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td><Bar used={s.rate_last_min} cap={s.rate_per_minute} /></td>
                      <td><Bar used={s.used_today} cap={s.daily_cap} /></td>
                      <td><Bar used={s.used_month} cap={s.monthly_cap} /></td>
                      <td><button className="btn secondary" onClick={() => startEdit(s)}>✎ Edit limits</button></td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
