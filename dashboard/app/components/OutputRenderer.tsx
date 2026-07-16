'use client';

// Explicit React import so this module also renders correctly under a direct
// `tsx --test` run (classic JSX transform, needs `React` in scope) — Next's
// own build uses the automatic runtime and doesn't need it, but keeping the
// import is harmless there.
import React, { type ReactElement } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { WorkflowRunOutput } from '../lib/api';

/** Parse YAML frontmatter out of markdown content. */
export function parseFrontmatter(content: string): { fields: [string, string][]; body: string } {
  if (!content.startsWith('---')) return { fields: [], body: content };
  const end = content.indexOf('\n---', 3);
  if (end === -1) return { fields: [], body: content };
  const fm = content.slice(3, end);
  const body = content.slice(end + 4).replace(/^\n/, '');
  const fields: [string, string][] = [];
  for (const line of fm.split('\n')) {
    const m = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (m) fields.push([m[1], m[2].replace(/^["']|["']$/g, '').trim()]);
  }
  return { fields, body };
}

/** Returns true if a raw frontmatter value string is effectively empty/null. */
function isFmEmpty(v: string): boolean {
  if (!v || v === 'null' || v === '~') return true;
  try { const p = JSON.parse(v); return Array.isArray(p) && p.length === 0; } catch { return false; }
}

/** Render a raw frontmatter value: JSON arrays become comma-separated text; empty/null values
 *  get a highlighted placeholder so missing data is visible rather than silently absent. */
function renderFmValue(v: string): React.ReactNode {
  if (isFmEmpty(v)) return <span className="md-fm-null">null</span>;
  try {
    const p = JSON.parse(v);
    if (Array.isArray(p) && p.every((x) => x === null || typeof x !== 'object')) {
      return p.join(', ');
    }
  } catch { /* not a JSON array — render as-is */ }
  return v;
}

/**
 * Renders a markdown output artifact's body (T262/T282 'markdown' form — the
 * default/legacy form; unchanged behaviour from before the format dispatch).
 */
function MarkdownOutputBody({ content, truncated }: { content: string; truncated?: boolean }) {
  const parsed = parseFrontmatter(content);
  return (
    <>
      {truncated && (
        <p className="muted" style={{ margin: 0, fontSize: '0.82em' }}>
          ⚠ Output is large — showing the first part only.
        </p>
      )}
      {parsed.fields.length > 0 && (
        <dl className="md-fm">
          {parsed.fields.map(([k, v]) => (
            <div key={k} className="md-fm-row">
              <dt className="md-fm-key">{k}</dt>
              <dd className="md-fm-val">{renderFmValue(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="md-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{parsed.body}</ReactMarkdown>
      </div>
    </>
  );
}

/**
 * Fallback renderer for a declared form with no dedicated renderer yet — shows
 * the raw content so a new form (e.g. T263's structured size table) is usable
 * before its own renderer is added, rather than rendering nothing. Also serves
 * as the registered `text` form (plain monospace, preserved whitespace).
 */
function RawOutputBody({ content, truncated }: { content: string; truncated?: boolean }) {
  return (
    <>
      {truncated && (
        <p className="muted" style={{ margin: 0, fontSize: '0.82em' }}>
          ⚠ Output is large — showing the first part only.
        </p>
      )}
      <pre
        style={{
          fontSize: 13,
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          background: 'var(--panel-2)',
          borderRadius: 6,
          padding: '10px 12px',
          margin: 0,
        }}
      >
        {content}
      </pre>
    </>
  );
}

/**
 * Renders a JSON output artifact's body — pretty-printed with 2-space indentation
 * inside the same monospace block `RawOutputBody` uses. Falls back to the raw
 * content (never throws / never renders blank) when the content isn't valid JSON.
 */
function JsonOutputBody({ content, truncated }: { content: string; truncated?: boolean }) {
  let pretty = content;
  try {
    pretty = JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    // Not valid JSON — fall through and render the raw content as-is.
  }
  return <RawOutputBody content={pretty} truncated={truncated} />;
}

/** Minimal shape of a plex-space-saver `SizeBreakdownFile` (see
 *  src/workflows/plex-space-saver/types.ts) — only the fields the bar chart needs. */
interface SizeBreakdownItem {
  title: string;
  human: string;
  bytes: number;
}
interface SizeBreakdownFile {
  items: SizeBreakdownItem[];
}

/**
 * Renders the plex-space-saver disk-size breakdown (T617) as one proportional
 * horizontal bar per title, biggest-first (the order the file is already sorted
 * in) — bar width scaled to that item's `bytes` relative to the largest item's
 * `bytes`. Falls back to `RawOutputBody` on invalid/empty JSON so it never
 * throws or renders blank.
 */
function SizeTableOutputBody({ content, truncated }: { content: string; truncated?: boolean }) {
  let items: SizeBreakdownItem[] | null = null;
  try {
    const parsed = JSON.parse(content) as SizeBreakdownFile;
    if (Array.isArray(parsed.items) && parsed.items.length > 0) items = parsed.items;
  } catch {
    // Not valid JSON — fall through to the raw fallback below.
  }
  if (!items) return <RawOutputBody content={content} truncated={truncated} />;

  const maxBytes = Math.max(...items.map((i) => i.bytes), 0);
  return (
    <>
      {truncated && (
        <p className="muted" style={{ margin: 0, fontSize: '0.82em' }}>
          ⚠ Output is large — showing the first part only.
        </p>
      )}
      <ul className="size-bar-list">
        {items.map((item, i) => {
          const pct = maxBytes > 0 ? (item.bytes / maxBytes) * 100 : 0;
          return (
            <li key={`${item.title}-${i}`} className="size-bar-row">
              <div className="size-bar-label">{item.title}</div>
              <div className="size-bar-track">
                <div className="size-bar-fill" style={{ width: `${pct}%` }} />
              </div>
              <div className="size-bar-value">{item.human}</div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/**
 * Renderer dispatch keyed by an output item's declared form (`WorkflowRunOutput.format`,
 * T262). Add a new form's renderer here — the extension point this refactor exists for.
 * A format with no entry falls back to `RawOutputBody` rather than failing to render.
 */
const OUTPUT_RENDERERS: Record<string, (props: { content: string; truncated?: boolean }) => ReactElement> = {
  markdown: MarkdownOutputBody,
  json: JsonOutputBody,
  text: RawOutputBody,
  'size-table': SizeTableOutputBody,
};

export function renderOutputBody(result: WorkflowRunOutput): ReactElement {
  // An unset format is the legacy default form ('markdown', per WorkflowRunOutput's
  // own doc comment) — an unrecognized format is what falls back to raw.
  const Renderer = OUTPUT_RENDERERS[result.format ?? 'markdown'] || RawOutputBody;
  return <Renderer content={result.content ?? ''} truncated={result.truncated} />;
}
