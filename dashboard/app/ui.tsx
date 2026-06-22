'use client';

import { useEffect, useRef, useState } from 'react';
import type { RunStatus } from './lib/api';

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
export function backFrom(
  from: string | null | undefined,
  fallback: { href: string; label: string },
): { href: string; label: string } {
  if (!from || !from.startsWith('/')) return fallback;
  const segs = from.split('?')[0].split('/').filter(Boolean);
  if (segs[0] === 'workflow-runs' && segs[1]) return { href: from, label: `#${segs[1]}` };
  if ((segs[0] === 'workflows' || segs[0] === 'jobs') && segs[1]) return { href: from, label: decodeURIComponent(segs[1]) };
  return fallback;
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
