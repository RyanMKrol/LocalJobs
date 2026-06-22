'use client';

import { useState, useEffect, useCallback } from 'react';
import { api, type CannedQueryResult, type TablePage } from '../lib/api';
import { usePoll } from '../ui';

const PAGE = 50;

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'object') return JSON.stringify(v, null, 2);
  return String(v);
}

function fmtCell(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function RowModal({ columns, row, onClose }: { columns: string[]; row: Record<string, unknown>; onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="db-modal-overlay" onClick={onClose}>
      <div className="db-modal" onClick={(e) => e.stopPropagation()}>
        <div className="db-modal-header">
          <span>Row detail</span>
          <button className="db-modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="db-modal-body">
          {columns.map((c) => (
            <div key={c} className="db-modal-row">
              <div className="db-modal-key mono">{c}</div>
              <div className="db-modal-val mono">{fmt(row[c])}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ResultTable({ columns, rows }: { columns: string[]; rows: Record<string, unknown>[] }) {
  const [selectedRow, setSelectedRow] = useState<Record<string, unknown> | null>(null);
  const closeModal = useCallback(() => setSelectedRow(null), []);

  return (
    <>
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={Math.max(1, columns.length)} className="muted">No rows.</td></tr>
            )}
            {rows.map((row, i) => (
              <tr key={i} className="db-row-clickable" onClick={() => setSelectedRow(row)}>
                {columns.map((c) => (
                  <td
                    key={c}
                    className="mono"
                    style={{ fontSize: 12, maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {fmtCell(row[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selectedRow && <RowModal columns={columns} row={selectedRow} onClose={closeModal} />}
    </>
  );
}

export default function DbBrowser() {
  const queriesPoll = usePoll(() => api.dbQueries(), 30000);
  const queries = queriesPoll.data?.queries ?? [];

  const tablesPoll = usePoll(() => api.dbTables(), 10000);
  const tables = tablesPoll.data?.tables ?? [];

  const [queryId, setQueryId] = useState<string | null>(null);
  const [table, setTable] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);

  // Canned query result: refetches when the selected query changes, kept live.
  const queryRes = usePoll<CannedQueryResult | null>(
    () => (queryId ? api.dbQuery(queryId) : Promise.resolve(null)),
    5000,
    [queryId],
  );
  const result = queryRes.data ?? null;

  // Refetches when the selected table or page changes (deps), and keeps the page
  // live-refreshing while open. Returns null when no table is selected yet.
  const { data, error } = usePoll<TablePage | null>(
    () => (table ? api.dbTable(table, PAGE, offset) : Promise.resolve(null)),
    5000,
    [table, offset],
  );
  const page = data ?? null;

  function pickQuery(id: string) {
    setQueryId(id);
    setTable(null);
  }

  function selectTable(t: string) {
    setTable(t);
    setQueryId(null);
    setOffset(0);
  }

  const activeQuery = queries.find((q) => q.id === queryId) ?? null;

  return (
    <>
      <h1>Database</h1>
      <p className="sub">Read-only views of the SQLite database: pick a common query, or browse a raw table. A viewer only — no edits, no free-form SQL. Auto-refreshes.</p>
      {queriesPoll.error && <p className="muted">⚠ Cannot reach the daemon API ({queriesPoll.error}).</p>}

      <h2 style={{ marginBottom: 6 }}>Common queries</h2>
      <div className="panel" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: 12 }}>
        {queries.length === 0 && <span className="muted">No queries.</span>}
        {queries.map((q) => (
          <button
            key={q.id}
            className={`btn ${q.id === queryId ? '' : 'secondary'}`}
            title={q.description}
            onClick={() => pickQuery(q.id)}
          >
            {q.title}
          </button>
        ))}
      </div>

      {queryId && (
        <>
          {activeQuery && <p className="muted" style={{ margin: '12px 0 8px' }}>{activeQuery.description}</p>}
          {queryRes.error && <p className="muted" style={{ color: 'var(--red)' }}>⚠ {queryRes.error}</p>}
          {result && (
            <>
              <p className="muted" style={{ margin: '0 0 8px' }}>
                {result.rows.length} row{result.rows.length === 1 ? '' : 's'}
              </p>
              <ResultTable columns={result.columns} rows={result.rows} />
            </>
          )}
        </>
      )}

      <h2 style={{ marginTop: 28, marginBottom: 6 }}>Browse tables</h2>
      {tablesPoll.error && <p className="muted">⚠ Cannot reach the daemon API ({tablesPoll.error}).</p>}
      <div className="panel" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: 12 }}>
        {tables.length === 0 && <span className="muted">No tables.</span>}
        {tables.map((t) => (
          <button key={t} className={`btn ${t === table ? '' : 'secondary'}`} onClick={() => selectTable(t)}>{t}</button>
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
          <ResultTable columns={page?.columns ?? []} rows={page?.rows ?? []} />
        </>
      )}
    </>
  );
}
