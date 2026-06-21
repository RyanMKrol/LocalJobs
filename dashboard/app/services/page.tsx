'use client';

import { api } from '../lib/api';
import { usePoll } from '../ui';

function Bar({ used, cap }: { used: number; cap: number | null }) {
  if (cap == null) return <span className="muted">no cap</span>;
  const pct = Math.min(100, (used / cap) * 100);
  const cls = pct >= 100 ? 'full' : pct >= 80 ? 'warn' : '';
  return (
    <div>
      <div className="mono" style={{ fontSize: 12 }}>{used} / {cap}</div>
      <div className="ubar"><span className={cls} style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

export default function Services() {
  const { data, error } = usePoll(() => api.services(), 3000);
  const services = data?.services ?? [];

  return (
    <>
      <h1>Services</h1>
      <p className="sub">Shared external dependencies with cross-job rate limits + quotas. Auto-refreshes.</p>
      {error && <p className="muted">⚠ Cannot reach the daemon API ({error}).</p>}
      <div className="panel">
        <table>
          <thead>
            <tr><th>Service</th><th>Rate (last min)</th><th>Today</th><th>This month</th></tr>
          </thead>
          <tbody>
            {services.length === 0 && <tr><td colSpan={4} className="muted">No services defined.</td></tr>}
            {services.map((s) => (
              <tr key={s.name}>
                <td>
                  <strong>{s.name}</strong> {s.paid ? <span className="pill paid">paid</span> : <span className="pill">free</span>}
                  <div className="muted" style={{ fontSize: 12 }}>{s.description}</div>
                </td>
                <td className="mono">{s.rate_last_min}{s.rate_per_minute != null ? ` / ${s.rate_per_minute}` : ''}</td>
                <td><Bar used={s.used_today} cap={s.daily_cap} /></td>
                <td><Bar used={s.used_month} cap={s.monthly_cap} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
