'use client';

import { Fragment, useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { api } from '../lib/api';
import { Pill } from '../components/Pill';

const DEFAULT_RUN_ALL_LIMIT = 3;

// Pretty-print a cached response_json value; falls back to the raw string if it
// isn't valid JSON (mirrors JsonOutputBody in components/OutputRenderer.tsx).
function prettyPrintJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

type ResetAllResult = Awaited<ReturnType<typeof api.resetAllWorkflowsOutput>>;
type RunAllResult = Awaited<ReturnType<typeof api.runAllWorkflows>>;
type CacheCounts = Awaited<ReturnType<typeof api.serviceCacheCounts>>['counts'];
type CacheRows = Awaited<ReturnType<typeof api.serviceCacheRows>>['rows'];

export default function AdminPage() {
  const [busy, setBusy] = useState(false);
  const [forceBusy, setForceBusy] = useState(false);
  const [result, setResult] = useState<ResetAllResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [runAllLimit, setRunAllLimit] = useState(DEFAULT_RUN_ALL_LIMIT);
  const [runAllBusy, setRunAllBusy] = useState(false);
  const [runAllResult, setRunAllResult] = useState<RunAllResult | null>(null);
  const [runAllErr, setRunAllErr] = useState<string | null>(null);

  const [cacheCounts, setCacheCounts] = useState<CacheCounts | null>(null);
  const [cacheLoadErr, setCacheLoadErr] = useState<string | null>(null);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheClearedMsg, setCacheClearedMsg] = useState<string | null>(null);
  const [cacheErr, setCacheErr] = useState<string | null>(null);

  // Per-service row browser (T611) — which service is currently expanded, its
  // fetched rows, and load state, keyed by service name.
  const [expandedCacheService, setExpandedCacheService] = useState<string | null>(null);
  const [cacheRowsByService, setCacheRowsByService] = useState<Record<string, CacheRows>>({});
  const [cacheRowsLoading, setCacheRowsLoading] = useState<string | null>(null);
  const [cacheRowsErr, setCacheRowsErr] = useState<string | null>(null);

  const loadCacheCounts = useCallback(async () => {
    try {
      const r = await api.serviceCacheCounts();
      setCacheCounts(r.counts);
      setCacheLoadErr(null);
    } catch (e) {
      setCacheLoadErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    loadCacheCounts();
  }, [loadCacheCounts]);

  const cacheTotal = cacheCounts?.reduce((sum, c) => sum + c.count, 0) ?? 0;

  async function clearAllCache() {
    if (!window.confirm('Clear ALL cached service responses? Services will re-fetch fresh data on their next call.')) {
      return;
    }
    setCacheBusy(true);
    setCacheErr(null);
    setCacheClearedMsg(null);
    try {
      const r = await api.clearServiceCache();
      setCacheClearedMsg(`Cleared ${r.cleared} cached response(s).`);
      await loadCacheCounts();
    } catch (e) {
      setCacheErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCacheBusy(false);
    }
  }

  async function toggleBrowseService(serviceName: string) {
    if (expandedCacheService === serviceName) {
      setExpandedCacheService(null);
      return;
    }
    setExpandedCacheService(serviceName);
    setCacheRowsErr(null);
    if (cacheRowsByService[serviceName]) return;
    setCacheRowsLoading(serviceName);
    try {
      const r = await api.serviceCacheRows(serviceName);
      setCacheRowsByService((prev) => ({ ...prev, [serviceName]: r.rows }));
    } catch (e) {
      setCacheRowsErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCacheRowsLoading(null);
    }
  }

  async function deleteAllOutput(force = false) {
    if (force && !window.confirm(
      'Delete ALL workflow output, INCLUDING certified workflows?\n\n' +
      'This bypasses the certification guard and resets certified workflows too. ' +
      'It cannot be undone. (Workflows with an active run are still skipped.)',
    )) return;
    const setBusyFlag = force ? setForceBusy : setBusy;
    setBusyFlag(true);
    setResult(null);
    setErr(null);
    try {
      const r = await api.resetAllWorkflowsOutput(force);
      setResult(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyFlag(false);
    }
  }

  async function confirmRunAll() {
    setRunAllBusy(true);
    setRunAllResult(null);
    setRunAllErr(null);
    try {
      const r = await api.runAllWorkflows(runAllLimit);
      setRunAllResult(r);
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
            disabled={runAllBusy}
            style={{ width: 80 }}
          />
        </div>

        <button
          className="btn"
          onClick={confirmRunAll}
          disabled={runAllBusy}
        >
          {runAllBusy ? 'Starting…' : 'Run all workflows'}
        </button>

        {runAllErr && <p style={{ fontSize: 12, color: 'var(--red)', marginTop: 10 }}>{runAllErr}</p>}

        {runAllResult && (
          <div style={{ marginTop: 16 }}>
            <p style={{ fontSize: 13, color: 'var(--green)' }}>
              Started {runAllResult.startedCount} of {runAllResult.totalWorkflows} workflow(s);{' '}
              {runAllResult.skippedCount} skipped. "Started" means the run was dispatched, not that
              it has finished — watch progress on the{' '}
              <Link href="/workflows">Workflows page</Link>.
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

      <h2>Cached responses</h2>
      <div className="panel" style={{ padding: 18 }}>
        <p className="sub" style={{ marginTop: 0 }}>
          Cached service responses (T451) — a short-lived, per-service TTL cache used to avoid
          redundant paid/rate-limited API calls. Clearing it forces every service's next call to be
          a real, fresh fetch.
        </p>
        {cacheLoadErr && <p style={{ fontSize: 12, color: 'var(--red)' }}>{cacheLoadErr}</p>}
        {!cacheLoadErr && cacheCounts && cacheCounts.length === 0 && (
          <p className="muted" style={{ fontSize: 13 }}>No cached responses — the cache is empty.</p>
        )}
        {!cacheLoadErr && cacheCounts && cacheCounts.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Service</th>
                <th>Cached rows</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {cacheCounts.map((c) => (
                <Fragment key={c.service_name}>
                  <tr>
                    <td>{c.service_name}</td>
                    <td>{c.count}</td>
                    <td>
                      <button className="btn" style={{ fontSize: 12, padding: '2px 8px' }} onClick={() => toggleBrowseService(c.service_name)}>
                        {expandedCacheService === c.service_name ? 'Hide' : 'Browse'}
                      </button>
                    </td>
                  </tr>
                  {expandedCacheService === c.service_name && (
                    <tr>
                      <td colSpan={3} style={{ background: 'var(--panel-2)' }}>
                        {cacheRowsLoading === c.service_name && (
                          <p className="muted" style={{ fontSize: 13 }}>Loading…</p>
                        )}
                        {cacheRowsErr && cacheRowsLoading !== c.service_name && (
                          <p style={{ fontSize: 12, color: 'var(--red)' }}>{cacheRowsErr}</p>
                        )}
                        {cacheRowsLoading !== c.service_name && cacheRowsByService[c.service_name] && (
                          cacheRowsByService[c.service_name].length === 0 ? (
                            <p className="muted" style={{ fontSize: 13 }}>No cached rows for this service.</p>
                          ) : (
                            <table>
                              <thead>
                                <tr>
                                  <th>Cache key</th>
                                  <th>Cached at</th>
                                  <th>Status</th>
                                  <th>Value</th>
                                </tr>
                              </thead>
                              <tbody>
                                {cacheRowsByService[c.service_name].map((row) => (
                                  <tr key={row.cache_key}>
                                    <td className="mono" style={{ fontSize: 12 }}>{row.cache_key}</td>
                                    <td className="muted" style={{ fontSize: 12 }}>{row.cached_at}</td>
                                    <td><Pill kind={row.live ? 'on' : 'off'}>{row.live ? 'Live' : 'Stale'}</Pill></td>
                                    <td>
                                      <details>
                                        <summary style={{ cursor: 'pointer', fontSize: 12 }}>view</summary>
                                        <pre
                                          style={{
                                            fontSize: 12,
                                            lineHeight: 1.5,
                                            whiteSpace: 'pre-wrap',
                                            wordBreak: 'break-word',
                                            background: 'var(--panel)',
                                            borderRadius: 6,
                                            padding: '8px 10px',
                                            margin: '6px 0 0',
                                          }}
                                        >
                                          {prettyPrintJson(row.response_json)}
                                        </pre>
                                      </details>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              <tr>
                <td><strong>Total</strong></td>
                <td><strong>{cacheTotal}</strong></td>
                <td></td>
              </tr>
            </tbody>
          </table>
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
          Workflows with an active run or a <strong>certified</strong> flag are skipped rather than reset.
          Every other workflow re-processes everything from scratch on its next run. To reset certified
          workflows too, use the <strong>including certified</strong> button.
        </p>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            className="btn btn-danger"
            onClick={() => deleteAllOutput(false)}
            disabled={busy || forceBusy}
          >
            {busy ? 'Deleting…' : 'Delete all workflow output'}
          </button>
          <button
            className="btn btn-danger"
            onClick={() => deleteAllOutput(true)}
            disabled={busy || forceBusy}
            title="Bypasses the certification guard — resets certified workflows too. Active runs are still skipped."
          >
            {forceBusy ? 'Deleting…' : 'Delete all output (including certified)'}
          </button>
        </div>

        {err && <p style={{ fontSize: 12, color: 'var(--red)', marginTop: 10 }}>{err}</p>}

        {result && (
          <div style={{ marginTop: 16 }}>
            <p style={{ fontSize: 13, color: 'var(--green)' }}>
              Reset {result.resetCount} of {result.totalWorkflows} workflow(s); {result.skippedCount} skipped.
              {result.forced ? ' Certification was bypassed (certified workflows were reset too).' : ''}
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
                        <Pill kind={r.status === 'reset' ? 'on' : 'off'}>{r.status}</Pill>
                      </td>
                      <td className="muted">
                        {r.status === 'reset'
                          ? `${r.itemsDeleted} ledger rows, ${r.runsDeleted} job runs, ${r.wfRunsDeleted} workflow runs, ${r.filesRemoved} output file entries${r.certified ? ' (certified — forced)' : ''}`
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

      <div className="panel" style={{ borderLeft: '3px solid var(--red)', padding: 18, marginTop: 16 }}>
        <strong>Clear all cached responses</strong>
        <p className="muted" style={{ fontSize: 13, margin: '4px 0 12px' }}>
          Deletes every row in the <code>service_cache</code> table, across all services. This is
          separate from the <strong>Delete all workflow output</strong> action above — that action
          never touches this cache, and this action never touches work-item ledgers, run history, or
          output files.
        </p>
        <button className="btn btn-danger" onClick={clearAllCache} disabled={cacheBusy}>
          {cacheBusy ? 'Clearing…' : 'Clear all cached responses'}
        </button>
        {cacheErr && <p style={{ fontSize: 12, color: 'var(--red)', marginTop: 10 }}>{cacheErr}</p>}
        {cacheClearedMsg && <p style={{ fontSize: 13, color: 'var(--green)', marginTop: 10 }}>{cacheClearedMsg}</p>}
      </div>
    </>
  );
}
