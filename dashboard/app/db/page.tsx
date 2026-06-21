'use client';

import { useState } from 'react';
import { api, type TablePage } from '../lib/api';
import { usePoll } from '../ui';

const PAGE = 50;

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export default function DbBrowser() {
  const tablesPoll = usePoll(() => api.dbTables(), 10000);
  const tables = tablesPoll.data?.tables ?? [];

  const [table, setTable] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);

  // Refetches when the selected table or page changes (deps), and keeps the page
  // live-refreshing while open. Returns null when no table is selected yet.
  const { data, error } = usePoll<TablePage | null>(
    () => (table ? api.dbTable(table, PAGE, offset) : Promise.resolve(null)),
    5000,
    [table, offset],
  );
  const page = data ?? null;

  function select(t: string) {
    setTable(t);
    setOffset(0);
  }

  return (
    <>
      <h1>Database</h1>
      <p className="sub">Read-only view of the SQLite tables for ad-hoc browsing — a viewer only, no edits. Auto-refreshes.</p>
      {tablesPoll.error && <p className="muted">⚠ Cannot reach the daemon API ({tablesPoll.error}).</p>}

      <div className="panel" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {tables.length === 0 && <span className="muted">No tables.</span>}
        {tables.map((t) => (
          <button key={t} className={`btn ${t === table ? '' : 'secondary'}`} onClick={() => select(t)}>{t}</button>
        ))}
      </div>

      {table && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '12px 0' }}>
            <strong className="mono">{table}</strong>
            {page && (
              <span className="muted">
                {page.total} row{page.total === 1 ? '' : 's'}
                {page.total > 0 && ` · showing ${page.offset + 1}–${page.offset + page.rows.length}`}
              </span>
            )}
            <span style={{ flex: 1 }} />
            <button className="btn secondary" disabled={offset === 0} onClick={() => setOffset((o) => Math.max(0, o - PAGE))}>‹ Prev</button>
            <button className="btn secondary" disabled={!page || offset + PAGE >= page.total} onClick={() => setOffset((o) => o + PAGE)}>Next ›</button>
          </div>
          {error && <p className="muted" style={{ color: 'var(--red)' }}>⚠ {error}</p>}
          <div className="panel" style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>{page?.columns.map((c) => <th key={c}>{c}</th>)}</tr>
              </thead>
              <tbody>
                {page && page.rows.length === 0 && (
                  <tr><td colSpan={Math.max(1, page.columns.length)} className="muted">No rows.</td></tr>
                )}
                {page?.rows.map((row, i) => (
                  <tr key={i}>
                    {page.columns.map((c) => (
                      <td
                        key={c}
                        className="mono"
                        title={fmt(row[c])}
                        style={{ fontSize: 12, maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      >
                        {fmt(row[c])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
