'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './lib/api';
import type { BulkScope, LogLine, RunStatus, StuckItem } from './lib/api';

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

// Emoji status glyphs (T142). Always rendered in a `.badge-emoji` span but hidden
// by default — globals.css only reveals them on a joyful (non-default) theme, and
// the reduce-motion / minimal-emoji toggle hides them again. So the default look
// is unchanged and the emoji are a purely additive, reversible accent.
const STATUS_EMOJI: Record<string, string> = {
  success:   '✅',
  failed:    '❌',
  timeout:   '⏳',
  running:   '🔄',
  queued:    '🕒',
  cancelled: '🚫',
  skipped:   '⤼',
  partial:   '◐',
  passed:    '✅',
  pending:   '⏳',
};

export function StatusBadge({ status }: { status: RunStatus }) {
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

/**
 * Shared back link for pages that navigate up to a workflow run.
 * Renders "← {workflow} run · {shortId}" (full id in the title tooltip) when
 * both workflowRunId and workflowName are known; falls back to a plain link
 * (e.g. "← runs" or "← workflows") when there is no workflow-run context.
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
    const shortId = workflowRunId.split('-')[0];
    return (
      <p className="muted">
        <a href={`/workflow-runs/${workflowRunId}`} title={workflowRunId}>
          ← {workflowName} run · {shortId}
        </a>
      </p>
    );
  }
  return (
    <p className="muted">
      <a href={fallback.href}>← {fallback.label}</a>
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

/* ──────────────────────────────────────────────────────────────────────────
   Theme-family / font / motion switcher (T184 — curated from the T142/T154
   evaluation set down to the owner's keepers)

   Mirrors the existing persisted-chooser pattern: small `use…()` hooks back
   each axis with localStorage and apply it to `document.documentElement`
   (`data-theme` / `data-font` / `data-motion`), so every page reacts live and
   the choice survives reloads. A pre-paint script in layout.tsx sets the same
   attributes BEFORE first paint (no flash).

   The switcher chooses the theme FAMILY (`default` / `pixel-picnic` /
   `sunny-8bit`); the light/dark MODE is NOT user-chosen — it's derived
   automatically from the viewer's local time of day (see useTimeMode) and
   written to `data-mode`. The `default` family's DARK mode is the original
   pre-T142 dark look (the :root palette), so an untouched dashboard at night is
   exactly the familiar dark dashboard; logs keep their fixed dark-terminal
   palette in BOTH modes.
   ────────────────────────────────────────────────────────────────────────── */

// Three theme FAMILIES (T184). Each has a light + dark palette in globals.css;
// the mode is picked by time of day, not here.
export type ThemeId = 'default' | 'pixel-picnic' | 'sunny-8bit';

export const THEMES: { id: ThemeId; label: string; emoji: string }[] = [
  { id: 'default',      label: 'Default',      emoji: '🌓' },
  { id: 'pixel-picnic', label: 'Pixel Picnic', emoji: '🧺' },
  { id: 'sunny-8bit',   label: 'Sunny 8-bit',  emoji: '🕹️' },
];

// Three fonts (T184): the unset System default, Baloo 2 (rounded body), and
// Space Mono. Baloo 2 uses a lighter heading weight so headers read crisp.
export type FontId = 'system' | 'baloo' | 'spacemono';

export const FONTS: { id: FontId; label: string }[] = [
  { id: 'system',    label: 'System (default)' },
  { id: 'baloo',     label: 'Baloo 2' },
  { id: 'spacemono', label: 'Space Mono' },
];

const prefersReducedMotion = () => {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
};

/** Back a single `data-*` html attribute with localStorage. `fallback` is the
 *  "untouched" value: it removes the attribute + key (so the default look wins). */
function useHtmlPref<T extends string>(key: string, attr: string, fallback: T) {
  const [val, setVal] = useState<T>(fallback);

  useEffect(() => {
    const stored = window.localStorage.getItem(key) as T | null;
    if (stored) setVal(stored);
  }, [key]);

  const update = (v: T) => {
    setVal(v);
    const root = document.documentElement;
    if (v === fallback) {
      window.localStorage.removeItem(key);
      root.removeAttribute(attr);
    } else {
      window.localStorage.setItem(key, v);
      root.setAttribute(attr, v);
    }
  };

  return [val, update] as const;
}

export function useTheme() { return useHtmlPref<ThemeId>('localjobs.theme', 'data-theme', 'default'); }
export function useFont() { return useHtmlPref<FontId>('localjobs.font', 'data-font', 'system'); }

/** Light during the day, dark in the evening/night, keyed off the viewer's local
 *  clock. Day = 07:00–18:59; otherwise dark. Pure so it can be unit-tested and is
 *  shared with the pre-paint script's inline equivalent in layout.tsx. */
export function modeForHour(hour: number): 'light' | 'dark' {
  return hour >= 7 && hour < 19 ? 'light' : 'dark';
}

/** Auto light/dark mode from the viewer's local time of day, written to the
 *  `data-mode` html attribute (the pre-paint script sets it first to avoid a
 *  flash; this keeps it in sync after hydration and re-checks hourly so a page
 *  left open across the day/night threshold flips on its own). NOT user-chosen. */
export function useTimeMode() {
  useEffect(() => {
    const apply = () =>
      document.documentElement.setAttribute('data-mode', modeForHour(new Date().getHours()));
    apply();
    const id = setInterval(apply, 5 * 60 * 1000); // re-evaluate every 5 min
    return () => clearInterval(id);
  }, []);
}

/** Reduce-motion / minimal-emoji toggle. Tri-state storage: explicit 'reduced' /
 *  'full', or absent = follow the OS `prefers-reduced-motion`. The returned
 *  boolean is the EFFECTIVE state; setting it persists an explicit choice. */
export function useMotion() {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem('localjobs.motion');
    setReduced(stored === 'reduced' || (stored == null && prefersReducedMotion()));
  }, []);

  const update = (v: boolean) => {
    setReduced(v);
    window.localStorage.setItem('localjobs.motion', v ? 'reduced' : 'full');
    if (v) document.documentElement.setAttribute('data-motion', 'reduced');
    else document.documentElement.removeAttribute('data-motion');
  };

  return [reduced, update] as const;
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

/**
 * Compact, unobtrusive settings control rendered in the header on EVERY page: a
 * single 🎨 button that opens a small popover offering Theme · Font · Reduce
 * motion. Built as a fixed-position modal so it never widens the header (keeps
 * the mobile check green) and is reachable at phone width.
 */
export function ThemeControls() {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  const [font, setFont] = useFont();
  const [reduced, setReduced] = useMotion();
  useTimeMode();

  return (
    <div className="theme-controls">
      <button
        className="theme-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Theme & font"
      >
        🎨<span className="theme-trigger-label"> Theme</span>
      </button>
      {open && (
        <div className="db-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div className="db-modal theme-modal" role="dialog" aria-modal="true" aria-label="Theme settings">
            <div className="db-modal-header">
              <span>🎨 Appearance</span>
              <button className="db-modal-close" onClick={() => setOpen(false)} aria-label="Close">×</button>
            </div>
            <div className="db-modal-body">
              <div className="theme-section">
                <div className="theme-section-label">Theme</div>
                <div className="theme-grid">
                  {THEMES.map((t) => (
                    <button
                      key={t.id}
                      className={`theme-opt${theme === t.id ? ' active' : ''}`}
                      onClick={() => setTheme(t.id)}
                      title={`${t.label} theme — light/dark follows time of day`}
                    >
                      <span aria-hidden="true">{t.emoji}</span> {t.label}
                    </button>
                  ))}
                </div>
                <p className="theme-section-hint">Light/dark follows your local time of day.</p>
              </div>

              <div className="theme-section">
                <div className="theme-section-label">Font</div>
                <div className="theme-grid">
                  {FONTS.map((f) => (
                    <button
                      key={f.id}
                      className={`theme-opt${font === f.id ? ' active' : ''}`}
                      onClick={() => setFont(f.id)}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="theme-section">
                <label className="toggle theme-motion">
                  <input type="checkbox" checked={reduced} onChange={(e) => setReduced(e.target.checked)} />
                  Reduce motion &amp; minimise emoji
                </label>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
