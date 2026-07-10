'use client';

import { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';

type CacheCounts = Awaited<ReturnType<typeof api.serviceCacheCounts>>['counts'];

export default function AdminCachePage() {
  const [counts, setCounts] = useState<CacheCounts | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [clearedMsg, setClearedMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.serviceCacheCounts();
      setCounts(r.counts);
      setLoadErr(null);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const total = counts?.reduce((sum, c) => sum + c.count, 0) ?? 0;

  async function clearAll() {
    if (!window.confirm('Clear ALL cached service responses? Services will re-fetch fresh data on their next call.')) {
      return;
    }
    setBusy(true);
    setErr(null);
    setClearedMsg(null);
    try {
      const r = await api.clearServiceCache();
      setClearedMsg(`Cleared ${r.cleared} cached response(s).`);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Service cache</h1>
      <p className="sub">
        Cached service responses (T451) — a short-lived, per-service TTL cache used to avoid
        redundant paid/rate-limited API calls. Clearing it forces every service's next call to be
        a real, fresh fetch.
      </p>

      <h2>Cached responses</h2>
      <div className="panel" style={{ padding: 18 }}>
        {loadErr && <p style={{ fontSize: 12, color: 'var(--red)' }}>{loadErr}</p>}
        {!loadErr && counts && counts.length === 0 && (
          <p className="muted" style={{ fontSize: 13 }}>No cached responses — the cache is empty.</p>
        )}
        {!loadErr && counts && counts.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Service</th>
                <th>Cached rows</th>
              </tr>
            </thead>
            <tbody>
              {counts.map((c) => (
                <tr key={c.service_name}>
                  <td>{c.service_name}</td>
                  <td>{c.count}</td>
                </tr>
              ))}
              <tr>
                <td><strong>Total</strong></td>
                <td><strong>{total}</strong></td>
              </tr>
            </tbody>
          </table>
        )}
      </div>

      <h2>Danger zone</h2>
      <div className="panel" style={{ borderLeft: '3px solid var(--red)', padding: 18 }}>
        <strong>Clear all cached responses</strong>
        <p className="muted" style={{ fontSize: 13, margin: '4px 0 12px' }}>
          Deletes every row in the <code>service_cache</code> table, across all services. This is
          separate from the <code>Delete all workflow output</code> action on the{' '}
          <a href="/admin">Admin</a> page — that action never touches this cache, and this action
          never touches work-item ledgers, run history, or output files.
        </p>
        <button className="btn btn-danger" onClick={clearAll} disabled={busy}>
          {busy ? 'Clearing…' : 'Clear all cached responses'}
        </button>
        {err && <p style={{ fontSize: 12, color: 'var(--red)', marginTop: 10 }}>{err}</p>}
        {clearedMsg && <p style={{ fontSize: 13, color: 'var(--green)', marginTop: 10 }}>{clearedMsg}</p>}
      </div>
    </>
  );
}
