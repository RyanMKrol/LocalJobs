'use client';

import { useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Strip YAML frontmatter from markdown and return the parsed fields + body.
 * Returns `{ fields: [key, value][], body: string }`.
 */
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

/** Full-markdown popover — renders LLM/scraped markdown via react-markdown (XSS-safe:
 *  no rehype-raw, raw HTML in the content is escaped, not executed). YAML frontmatter
 *  is stripped and shown as a compact key-value header above the body.
 *  When `loading` is true the body shows a loading indicator instead of content. */
export function MarkdownModal(
  { title, content, truncated, loading, onClose }: {
    title: string;
    content?: string;
    truncated?: boolean;
    loading?: boolean;
    onClose: () => void;
  },
) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const parsed = content ? parseFrontmatter(content) : null;

  return (
    <div className="db-modal-overlay" onClick={onClose}>
      <div className="db-modal md-modal" onClick={(e) => e.stopPropagation()}>
        <div className="db-modal-header">
          <span>{title}</span>
          <button className="db-modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="db-modal-body">
          {loading && <p className="muted" style={{ margin: 0 }}>Loading…</p>}
          {!loading && parsed && (
            <>
              {truncated && <p className="muted" style={{ margin: 0, fontSize: '0.82em' }}>⚠ Output is large — showing the first part only.</p>}
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
          )}
        </div>
      </div>
    </div>
  );
}
