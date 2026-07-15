'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
// @ts-expect-error react-dom has no bundled/installed type declarations in this project
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { api } from './lib/api';
import type { BulkScope, LogLine, StuckItem } from './lib/api';

const STATUS_LABELS: Record<string, string> = {
  success:   'Succeeded',
  failed:    'Failed',
  running:   'Running',
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

// Emoji status glyphs (T142). Always rendered in a `.badge-emoji` span but hidden
// by default — globals.css only reveals them on a joyful (non-default) theme, and
// the reduce-motion / minimal-emoji toggle hides them again. So the default look
// is unchanged and the emoji are a purely additive, reversible accent.
const STATUS_EMOJI: Record<string, string> = {
  success:   '✅',
  failed:    '❌',
  timeout:   '⏳',
  running:   '🔄',
  cancelled: '🚫',
  skipped:   '⤼',
  partial:   '◐',
  passed:    '✅',
  pending:   '⏳',
};

export function StatusBadge({ status }: { status: string }) {
  const emoji = STATUS_EMOJI[status];
  return (
    <span className={`badge ${status}`}>
      {emoji && <span className="badge-emoji" aria-hidden="true">{emoji}</span>}
      {statusLabel(status)}
    </span>
  );
}

export function ProgressBar({ pct, done }: { pct: number; done?: boolean }) {
  const clampedPct = Math.max(0, Math.min(100, pct));
  const isDone = done ?? clampedPct >= 100;
  return (
    <div className={isDone ? 'progress done' : 'progress'}>
      <span style={{ width: `${clampedPct}%` }} />
    </div>
  );
}

export function fmtDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function fmtTime(t: string | null): string {
  if (!t) return '—';
  // SQLite datetime() is UTC without a 'Z'; mark it so JS parses correctly.
  const d = new Date(t.includes('Z') || t.includes('T') ? t : t.replace(' ', 'T') + 'Z');
  return d.toLocaleString();
}

export function fmtRelative(t: string | null): string {
  if (!t) return '—';
  const d = new Date(t.includes('Z') || t.includes('T') ? t : t.replace(' ', 'T') + 'Z').getTime();
  const diff = Date.now() - d;
  if (diff < 0) return 'just now';
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

/**
 * Shared back link for pages that navigate up to a workflow run.
 * Renders "← {workflowRunId}" (full id) when both workflowRunId and
 * workflowName are known; falls back to a plain link (e.g. "← runs" or
 * "← workflows") when there is no workflow-run context.
 */
export function WorkflowRunBackLink({
  workflowRunId,
  workflowName,
  fallback = { href: '/runs', label: 'runs' },
}: {
  workflowRunId?: string | null;
  workflowName?: string | null;
  fallback?: { href: string; label: string };
}) {
  if (workflowRunId && workflowName) {
    return (
      <p className="muted">
        <Link href={`/workflow-runs/${workflowRunId}`}>
          ← {workflowRunId}
        </Link>
      </p>
    );
  }
  return (
    <p className="muted">
      <Link href={fallback.href}>← {fallback.label}</Link>
    </p>
  );
}

const DAYS_OF_WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Convert a 5-field cron expression to a short English phrase.
 *  Returns the raw expression unchanged when the pattern isn't recognised —
 *  so a wrong description is never shown. */
export function cronToEnglish(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, month, dow] = parts;

  const isNum = (s: string) => /^\d+$/.test(s);
  const toInt = (s: string) => parseInt(s, 10);
  const pad2   = (n: number) => String(n).padStart(2, '0');
  const ordinal = (n: number) => {
    const s = ['th','st','nd','rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
  };

  // Monthly at HH:MM on day D: M H D * *  (month=*, dow=*)
  if (isNum(min) && isNum(hour) && isNum(dom) && month === '*' && dow === '*') {
    const h = toInt(hour), m = toInt(min), d = toInt(dom);
    if (h >= 0 && h < 24 && m >= 0 && m < 60 && d >= 1 && d <= 31)
      return `At ${pad2(h)}:${pad2(m)} on the ${ordinal(d)} of each month`;
  }

  // Patterns below require month='*' — bail out for month-specific expressions
  if (month !== '*') return expr;

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
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPos({
        top: rect.top + window.scrollY,
        left: rect.left + rect.width / 2 + window.scrollX,
      });
    }
  }, [open]);

  if (english === expr) return <span className="mono">{expr}</span>;
  return (
    <span className="cron-badge">
      <span className="mono">{expr}</span>
      <span
        ref={triggerRef}
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
        {open && pos && typeof document !== 'undefined' && createPortal(
          <span
            className="cron-tooltip"
            role="tooltip"
            style={{
              position: 'absolute',
              top: pos.top - 6,
              left: pos.left,
              transform: 'translate(-50%, -100%)',
            }}
          >
            {english}
          </span>,
          document.body,
        )}
      </span>
    </span>
  );
}

/** Minimal shape of `document` that {@link createPollController} needs — lets tests inject a fake. */
export interface PollDocumentLike {
  visibilityState: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface PollController {
  /** Stop the interval, detach the visibility listener, and discard any in-flight tick's result. */
  stop(): void;
  /** Fetch immediately, out of band from the interval (used for the manual "refresh" affordance). */
  refetch(): void;
}

/**
 * The non-React core of {@link usePoll}: owns the interval, the visibility pause/resume, and the
 * out-of-order-response guard. Extracted so it's testable without mounting a React tree — `usePoll`
 * is a thin wrapper that supplies `setData`/`setError` from `useState`.
 */
export function createPollController<T>(opts: {
  fn: () => Promise<T>;
  intervalMs: number;
  setData: (d: T) => void;
  setError: (e: string | null) => void;
  doc?: PollDocumentLike;
  setIntervalFn?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (id: ReturnType<typeof setInterval>) => void;
}): PollController {
  const { fn, intervalMs } = opts;
  const doc = opts.doc ?? (typeof document !== 'undefined' ? document : undefined);
  const setIntervalFn = opts.setIntervalFn ?? setInterval;
  const clearIntervalFn = opts.clearIntervalFn ?? clearInterval;

  let alive = true;
  let seq = 0;
  let id: ReturnType<typeof setInterval> | null = null;

  const tick = async () => {
    const mySeq = ++seq;
    try {
      const d = await fn();
      if (alive && seq === mySeq) { opts.setData(d); opts.setError(null); }
    } catch (e) {
      if (alive && seq === mySeq) opts.setError(e instanceof Error ? e.message : 'error');
    }
  };

  const start = () => { if (id === null) id = setIntervalFn(tick, intervalMs); };
  const stop = () => { if (id !== null) { clearIntervalFn(id); id = null; } };

  const onVisibility = () => {
    if (!doc) return;
    if (doc.visibilityState === 'hidden') {
      stop();
    } else {
      stop();
      tick();
      start();
    }
  };

  tick();
  if (!doc || doc.visibilityState !== 'hidden') start();
  doc?.addEventListener('visibilitychange', onVisibility);

  return {
    stop: () => {
      alive = false;
      stop();
      doc?.removeEventListener('visibilitychange', onVisibility);
    },
    refetch: () => { tick(); },
  };
}

/**
 * Poll an async function on an interval; returns latest data + error. Discards a stale response
 * that resolves after a more recent one (sequence-guarded), pauses the interval while the tab is
 * hidden, and refetches immediately on becoming visible again.
 */
export function usePoll<T>(fn: () => Promise<T>, intervalMs: number, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const controllerRef = useRef<PollController | null>(null);

  useEffect(() => {
    const controller = createPollController<T>({
      fn: () => fnRef.current(),
      intervalMs,
      setData,
      setError,
    });
    controllerRef.current = controller;
    return () => {
      controller.stop();
      controllerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, ...deps]);

  const refetch = useCallback(() => controllerRef.current?.refetch(), []);

  return { data, error, refetch };
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
            <p className="muted empty-joy" style={{ padding: '16px' }}>Nothing stuck — nice <span className="joy-emoji" aria-hidden="true">✨</span></p>
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
                        <td><Link href={`/jobs/${s.job_name}`}>{s.job_name}</Link></td>
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

/* ──────────────────────────────────────────────────────────────────────────
   Light/dark/system mode control (T344 — reintroduces "System" on top of the
   T308 binary toggle, per an explicit owner UX-reversal request; the dashboard's
   theme-family + font stay hardcoded in globals.css / layout.tsx — this only
   concerns the mode control).

   `useMode` backs a single `data-mode` html attribute with localStorage under
   `localjobs.mode`, so every page reacts live and the choice survives reloads.
   A pre-paint script in layout.tsx sets the same attribute BEFORE first paint
   (no flash). The SAME compact single header button (T308's rationale for a
   compact, unobtrusive control still holds — no dropdown/popover) now CYCLES
   through three explicit, persisted states in a fixed order on each click:
   Dark → Light → System → Dark → … . In System state the rendered appearance
   follows the OS `prefers-color-scheme` live, exactly like the pre-T308/T190
   tri-state picker did.
   ────────────────────────────────────────────────────────────────────────── */

// Tri-state mode (T344 — reintroduces "System" on top of T308's binary toggle).
export type ModeId = 'dark' | 'light' | 'system';

/** Pure helper: maps the stored mode choice + OS dark-preference → effective data-mode value.
 *  No stored choice, or an explicit 'system' choice, = follow the OS preference. */
export function resolveMode(stored: ModeId | null, osPrefersDark: boolean): 'light' | 'dark' {
  if (stored === 'dark') return 'dark';
  if (stored === 'light') return 'light';
  // stored === 'system' or null (untouched) — both follow the OS preference.
  return osPrefersDark ? 'dark' : 'light';
}

const MODE_CYCLE: Record<ModeId, ModeId> = { dark: 'light', light: 'system', system: 'dark' };

/** Light/dark/system mode, written to the `data-mode` html attribute (which only
 *  ever holds the RESOLVED 'light'/'dark' value — never 'system'). The pre-paint
 *  script sets `data-mode` first (no flash); this keeps it in sync after
 *  hydration. While `mode === 'system'` a `matchMedia` listener keeps the page
 *  reacting live to OS-preference changes; it's detached otherwise. `cycle()`
 *  advances dark → light → system → dark and persists the CHOICE (including the
 *  literal string 'system', so it isn't confused with "nothing stored"). */
export function useMode(): [ModeId, () => void] {
  // Hydration-safe initial state (T363): this MUST return the identical value on the
  // server and on the client's first render, or React treats it as a genuine content
  // mismatch several levels below <html> (outside what <html>'s suppressHydrationWarning
  // covers) and discards + regenerates the whole document on the client — which wipes the
  // pre-paint script's already-correct `data-mode` attribute, flashing the wrong palette.
  // The real persisted mode is applied below, in the mount effect, client-only.
  const [mode, setMode] = useState<ModeId>('dark');

  // Reconcile with the real persisted choice on mount (client-only, after hydration).
  useEffect(() => {
    const stored = window.localStorage.getItem('localjobs.mode') as ModeId | null;
    const real = stored === 'dark' || stored === 'light' || stored === 'system' ? stored : 'system';
    setMode((current) => (real !== current ? real : current));
  }, []);

  // The very first run of this effect corresponds to the hardcoded 'dark' placeholder
  // render above, which the pre-paint script in layout.tsx has ALREADY correctly applied
  // to `data-mode` before hydration — so it's skipped here to avoid clobbering that
  // correct value with the wrong placeholder for one frame. Every subsequent run (the
  // mount-reconcile's setMode, a cycle(), or an OS preference change) applies normally.
  const skippedFirstApply = useRef(false);
  useEffect(() => {
    if (!skippedFirstApply.current) {
      skippedFirstApply.current = true;
      return;
    }
    if (mode !== 'system') {
      document.documentElement.setAttribute('data-mode', mode);
      return;
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.setAttribute('data-mode', mq.matches ? 'dark' : 'light');
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [mode]);

  const cycle = () => {
    const next = MODE_CYCLE[mode];
    setMode(next);
    window.localStorage.setItem('localjobs.mode', next);
  };

  return [mode, cycle];
}


/**
 * One-click "Copy logs" button. Formats every log line as "<timestamp> [LEVEL] message"
 * and writes it to the clipboard. Falls back to selecting the text in a hidden textarea
 * when the clipboard API is unavailable. Shows "Copied!" for 1.5 s after success.
 */
export function CopyLogsButton({ logs }: { logs: LogLine[] }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copy = useCallback(() => {
    const text = logs
      .map((l) => `${l.ts} [${l.level.toUpperCase()}] ${l.message}`)
      .join('\n');

    const done = () => {
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    };

    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => {
        // Clipboard write rejected (e.g. permissions) — fall back to textarea select.
        fallbackCopy(text);
        done();
      });
    } else {
      fallbackCopy(text);
      done();
    }
  }, [logs]);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  return (
    <button
      type="button"
      className="btn secondary copy-logs-btn"
      onClick={copy}
      disabled={logs.length === 0}
      title="Copy all logs to clipboard"
    >
      {copied ? 'Copied!' : 'Copy logs'}
    </button>
  );
}

function fallbackCopy(text: string) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try { document.execCommand('copy'); } catch { /* silent — nothing better we can do */ }
  document.body.removeChild(ta);
}

const MODE_ICON: Record<ModeId, string> = { dark: '🌙', light: '☀️', system: '🖥️' };
const MODE_LABEL: Record<ModeId, string> = {
  dark: 'Dark mode — click for light mode',
  light: 'Light mode — click for system mode',
  system: 'System mode (follows OS) — click for dark mode',
};

/**
 * Compact, unobtrusive control rendered in the header on EVERY page (T308,
 * extended by T344): a single icon button that CYCLES Dark → Light → System →
 * Dark on click — no popover/modal, no theme-family or font choice.
 */
export function ThemeControls() {
  const [mode, cycle] = useMode();

  return (
    <div className="theme-controls">
      <button
        className="theme-trigger"
        onClick={cycle}
        aria-label={MODE_LABEL[mode]}
        title={MODE_LABEL[mode]}
      >
        <span aria-hidden="true">{MODE_ICON[mode]}</span>
      </button>
    </div>
  );
}
