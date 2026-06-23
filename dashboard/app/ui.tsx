'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from './lib/api';
import type { BulkScope, RunStatus, StuckItem } from './lib/api';

const STATUS_LABELS: Record<string, string> = {
  success:   'Succeeded',
  failed:    'Failed',
  running:   'Running',
  queued:    'Queued',
  timeout:   'Timed out',
  cancelled: 'Cancelled',
  skipped:   'Skipped',
  partial:   'Partial',
  passed:    'Passed',
  pending:   'Pending',
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

/**
 * The five compact validation-gate display styles the graph views can switch
 * between (T099). This is an EVALUATION aid: once a favourite is chosen a
 * FOLLOW-UP task will hardcode the winner and remove this toggle + the unused
 * styles. Each entry: stable `id` (persisted), short `label` for the toggle, and
 * a `hint` tooltip describing the style.
 */
export const GATE_STYLES = [
  { id: 'icon',      label: 'Icon',  hint: 'Icon-only ⛒ chip, coloured by state — hover for full detail.' },
  { id: 'dot',       label: 'Dot',   hint: 'Bare state-coloured dot — the most minimal; hover for detail.' },
  { id: 'key',       label: 'Key',   hint: 'Tiny pill showing just the artifact key (no producer name).' },
  { id: 'connector', label: 'Arrow', hint: 'No chip — the connecting arrow itself is coloured by state and clickable.' },
  { id: 'lock',      label: 'Lock',  hint: 'Compact 🔒 badge, coloured by state — hover for full detail.' },
] as const;

export type GateStyle = (typeof GATE_STYLES)[number]['id'];

const GATE_STYLE_KEY = 'localjobs.gateStyle';
const DEFAULT_GATE_STYLE: GateStyle = 'icon';

/**
 * Read/write the user's chosen gate display style, persisted to localStorage so it
 * survives polling re-renders and navigation between the two graph views. Starts at
 * the default on first render (SSR-safe — localStorage is read in an effect after
 * mount to avoid a hydration mismatch).
 */
export function useGateStyle(): [GateStyle, (s: GateStyle) => void] {
  const [style, setStyle] = useState<GateStyle>(DEFAULT_GATE_STYLE);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(GATE_STYLE_KEY);
      if (saved && GATE_STYLES.some((s) => s.id === saved)) setStyle(saved as GateStyle);
    } catch { /* localStorage unavailable — keep default */ }
  }, []);
  const set = (s: GateStyle) => {
    setStyle(s);
    try { localStorage.setItem(GATE_STYLE_KEY, s); } catch { /* ignore persistence failure */ }
  };
  return [style, set];
}

/**
 * The five distinct output line-item styles for the workflow-run IO panel (T116).
 * EVALUATION AID: once the user picks a favourite, a follow-up task will
 * hardcode the winner and remove this toggle + unused styles.
 */
export const OUTPUT_STYLES = [
  { id: 'filename', label: 'Filename', hint: 'Filename only + a separate "Preview" button to open the popover.' },
  { id: 'title',    label: 'Title',    hint: 'File icon + document title (no excerpt), whole row clickable.' },
  { id: 'excerpt',  label: 'Excerpt',  hint: 'Title + short excerpt + filename path (the original style).' },
  { id: 'meta',     label: 'Meta',     hint: 'Filename link + file size — for quick at-a-glance metadata.' },
  { id: 'chip',     label: 'Chip',     hint: 'Compact inline chip; excerpt shown in tooltip, click to preview.' },
] as const;

export type OutputStyle = (typeof OUTPUT_STYLES)[number]['id'];

const OUTPUT_STYLE_KEY = 'localjobs.outputStyle';
const DEFAULT_OUTPUT_STYLE: OutputStyle = 'excerpt';

/** Read/write the user's chosen output line-item style, persisted to localStorage. */
export function useOutputStyle(): [OutputStyle, (s: OutputStyle) => void] {
  const [style, setStyle] = useState<OutputStyle>(DEFAULT_OUTPUT_STYLE);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(OUTPUT_STYLE_KEY);
      if (saved && OUTPUT_STYLES.some((s) => s.id === saved)) setStyle(saved as OutputStyle);
    } catch { /* localStorage unavailable — keep default */ }
  }, []);
  const set = (s: OutputStyle) => {
    setStyle(s);
    try { localStorage.setItem(OUTPUT_STYLE_KEY, s); } catch { /* ignore */ }
  };
  return [style, set];
}


export function StatusBadge({ status }: { status: RunStatus }) {
  return <span className={`badge ${status}`}>{statusLabel(status)}</span>;
}

export function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="progress">
      <span style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

export function fmtDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

export function fmtTime(t: string | null): string {
  if (!t) return '—';
  // SQLite datetime() is UTC without a 'Z'; mark it so JS parses correctly.
  const d = new Date(t.includes('Z') || t.includes('T') ? t : t.replace(' ', 'T') + 'Z');
  return d.toLocaleString();
}

export function fmtRelative(t: string | null): string {
  if (!t) return '—';
  const d = new Date(t.replace(' ', 'T') + 'Z').getTime();
  const diff = Date.now() - d;
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * Resolve a back-link from a `?from=` path (threaded onto DAG node links), so a
 * job/run page returns to where you actually navigated from — the workflow or the
 * workflow run — rather than a fixed parent. Falls back to `fallback` when `from`
 * is absent/foreign.
 */
export function exitCodeLabel(code: number | null): string {
  if (code === null) return 'no exit code';
  if (code === 0) return 'OK';
  if (code === 1) return 'failed — exception';
  if (code === 137) return 'killed (SIGKILL)';
  if (code === 143) return 'terminated (SIGTERM)';
  return 'unexpected exit';
}

export function backFrom(
  from: string | null | undefined,
  fallback: { href: string; label: string },
): { href: string; label: string } {
  if (!from || !from.startsWith('/')) return fallback;
  const segs = from.split('?')[0].split('/').filter(Boolean);
  if (segs[0] === 'workflow-runs' && segs[1]) return { href: from, label: segs[1] };
  if ((segs[0] === 'workflows' || segs[0] === 'jobs') && segs[1]) return { href: from, label: decodeURIComponent(segs[1]) };
  return fallback;
}

const DAYS_OF_WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Convert a 5-field cron expression to a short English phrase.
 *  Returns the raw expression unchanged when the pattern isn't recognised —
 *  so a wrong description is never shown. */
export function cronToEnglish(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, month, dow] = parts;
  if (month !== '*') return expr; // don't attempt month-specific patterns

  const isNum = (s: string) => /^\d+$/.test(s);
  const toInt = (s: string) => parseInt(s, 10);
  const pad2   = (n: number) => String(n).padStart(2, '0');

  // Every minute: * * * * *
  if (min === '*' && hour === '*' && dom === '*' && dow === '*') return 'Every minute';

  // Every N minutes: */N * * * *
  if (min.startsWith('*/') && hour === '*' && dom === '*' && dow === '*') {
    const n = toInt(min.slice(2));
    if (n > 0) return `Every ${n} minute${n === 1 ? '' : 's'}`;
  }

  // Every hour: 0 * * * *
  if (min === '0' && hour === '*' && dom === '*' && dow === '*') return 'Every hour';

  // Every N hours on the hour: 0 */N * * *
  if (min === '0' && hour.startsWith('*/') && dom === '*' && dow === '*') {
    const n = toInt(hour.slice(2));
    if (n > 0) return `Every ${n} hour${n === 1 ? '' : 's'}`;
  }

  // At M minutes past every hour: M * * * *
  if (isNum(min) && hour === '*' && dom === '*' && dow === '*') {
    const m = toInt(min);
    if (m >= 0 && m < 60) return `At ${m} ${m === 1 ? 'minute' : 'minutes'} past every hour`;
  }

  // Daily at HH:MM: M H * * *
  if (isNum(min) && isNum(hour) && dom === '*' && dow === '*') {
    const h = toInt(hour), m = toInt(min);
    if (h >= 0 && h < 24 && m >= 0 && m < 60)
      return `At ${pad2(h)}:${pad2(m)}, every day`;
  }

  // Weekly on a named day at HH:MM: M H * * D  (single digit dow)
  if (isNum(min) && isNum(hour) && dom === '*' && /^\d$/.test(dow)) {
    const h = toInt(hour), m = toInt(min), d = toInt(dow);
    if (h >= 0 && h < 24 && m >= 0 && m < 60 && d >= 0 && d <= 6)
      return `At ${pad2(h)}:${pad2(m)} on ${DAYS_OF_WEEK[d]}`;
  }

  return expr; // unrecognised — fall back to raw, never show wrong description
}

/**
 * Renders a cron expression with an explicit ⓘ icon that shows the human-readable
 * description instantly on hover, focus, or tap — no native-title delay.
 * When cronToEnglish can't translate the expression it falls back to plain text
 * (no icon, since there's nothing useful to show).
 */
export function CronBadge({ expr }: { expr: string }) {
  const english = cronToEnglish(expr);
  const [open, setOpen] = useState(false);
  if (english === expr) return <span className="mono">{expr}</span>;
  return (
    <span className="cron-badge">
      <span className="mono">{expr}</span>
      <span
        className="cron-help"
        tabIndex={0}
        role="button"
        aria-label={`Schedule description: ${english}`}
        aria-haspopup="true"
        aria-expanded={open}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={e => { e.stopPropagation(); setOpen(v => !v); }}
      >
        ?
        {open && <span className="cron-tooltip" role="tooltip">{english}</span>}
      </span>
    </span>
  );
}

/** Poll an async function on an interval; returns latest data + error. */
export function usePoll<T>(fn: () => Promise<T>, intervalMs: number, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const d = await fnRef.current();
        if (alive) { setData(d); setError(null); }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'error');
      }
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => { alive = false; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error };
}

/**
 * Reusable modal that lists stuck items with per-item Unstick/Ignore controls
 * and 'Unstick all' / 'Ignore all' bulk actions (with confirmation). Accepts an
 * optional `scope` to limit the view and bulk actions to a job or workflow's
 * member jobs — pass nothing for "all stuck items".
 *
 * On any action the `onAction` callback is called so the parent can force a
 * data refresh.
 */
export function StuckPopover({
  items,
  scope,
  onClose,
  onAction,
}: {
  items: StuckItem[];
  scope?: BulkScope;
  onClose: () => void;
  onAction: () => void;
}) {
  async function handleUnstick(job: string, key: string) {
    try { await api.unstick(job, key); } catch { /* parent poll will reconcile */ }
    onAction();
  }

  async function handleIgnore(job: string, key: string) {
    if (!window.confirm(`Permanently ignore "${key}"?\n\nIt will never be retried and drops off the stuck list. Use Unstick instead if you want it retried.`)) return;
    try { await api.ignore(job, key); } catch { /* parent poll will reconcile */ }
    onAction();
  }

  async function handleUnstickAll() {
    if (!window.confirm(`Unstick all ${items.length} item${items.length === 1 ? '' : 's'}?\n\nThey will be retried fresh on the next run.`)) return;
    try { await api.unstickBulk(scope); } catch { /* parent poll will reconcile */ }
    onAction();
  }

  async function handleIgnoreAll() {
    if (!window.confirm(`Permanently ignore all ${items.length} item${items.length === 1 ? '' : 's'}?\n\nThey will never be retried and drop off the stuck list. This cannot be undone automatically.`)) return;
    try { await api.ignoreBulk(scope); } catch { /* parent poll will reconcile */ }
    onAction();
  }

  return (
    <div className="db-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="db-modal stuck-popover" role="dialog" aria-modal="true" aria-label="Stuck items">
        <div className="db-modal-header">
          <span>⛔ Stuck items ({items.length})</span>
          <button className="db-modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="db-modal-body" style={{ padding: 0 }}>
          {items.length === 0 ? (
            <p className="muted" style={{ padding: '16px' }}>No stuck items.</p>
          ) : (
            <>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%' }}>
                  <thead>
                    <tr><th>Item</th><th>Job</th><th>Att</th><th>Reason</th><th>When</th><th></th></tr>
                  </thead>
                  <tbody>
                    {items.map((s) => (
                      <tr key={`${s.job_name}:${s.item_key}`}>
                        <td style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {s.detail?.name ?? <span className="mono">{s.item_key}</span>}
                        </td>
                        <td><a href={`/jobs/${s.job_name}`}>{s.job_name}</a></td>
                        <td>{s.attempts}</td>
                        <td className="muted" style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {s.detail?.error ?? s.detail?.status ?? '—'}
                          {s.detail?.pageTitle ? ` · "${s.detail.pageTitle}"` : ''}
                        </td>
                        <td className="muted">{fmtRelative(s.updated_at)}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <button className="btn" onClick={() => handleUnstick(s.job_name, s.item_key)}>↻</button>{' '}
                          <button className="btn" onClick={() => handleIgnore(s.job_name, s.item_key)} title="Permanently ignore">✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="stuck-popover-bulk">
                <button className="btn secondary" onClick={handleUnstickAll}>↻ Unstick all ({items.length})</button>
                <button className="btn" onClick={handleIgnoreAll} title="Permanently ignore all — cannot be undone">✕ Ignore all ({items.length})</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
