// Coverage for the shared output-renderer dispatch (T458) — confirms the
// format-keyed dispatch table picks the right renderer body for each declared
// `WorkflowRunOutput.format`, with graceful fallbacks (no throw) for bad JSON
// and unrecognized formats.
//
// Self-running (mirrors the src/*.test.ts convention): run directly with
//   npx tsx --test dashboard/app/components/OutputRenderer.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderOutputBody } from './OutputRenderer.js';
import type { WorkflowRunOutput } from '../lib/api.js';

function render(result: WorkflowRunOutput): string {
  return renderToStaticMarkup(renderOutputBody(result));
}

function base(overrides: Partial<WorkflowRunOutput>): WorkflowRunOutput {
  return { found: true, job: 'some-job', key: 'some-key', ...overrides };
}

async function main() {
  await test('json format: pretty-prints valid JSON with indentation', () => {
    const html = render(base({ format: 'json', content: '{"a":1,"nested":{"b":2}}' }));
    assert.ok(html.includes('<pre'), 'should render inside a <pre> block');
    // JSON.stringify(..., null, 2) inserts a newline + 2-space indent before nested keys
    // (rendered HTML-escapes the quote as &quot;).
    assert.ok(html.includes('\n  &quot;a&quot;'), 'should be indented, not collapsed to one line');
    assert.ok(html.includes('\n  &quot;nested&quot;'));
  });

  await test('json format: falls back to raw content (no throw) for invalid JSON', () => {
    const badContent = 'not valid { json';
    assert.doesNotThrow(() => render(base({ format: 'json', content: badContent })));
    const html = render(base({ format: 'json', content: badContent }));
    assert.ok(html.includes('not valid { json'));
    assert.ok(html.includes('<pre'));
  });

  await test('text format: renders raw content in a monospace block', () => {
    const html = render(base({ format: 'text', content: 'line one\nline two' }));
    assert.ok(html.includes('<pre'));
    assert.ok(html.includes('line one'));
    assert.ok(html.includes('line two'));
  });

  await test('unrecognized format: falls back to the raw/text renderer', () => {
    const html = render(base({ format: 'size-table', content: 'col1,col2\n1,2' }));
    assert.ok(html.includes('<pre'));
    assert.ok(html.includes('col1,col2'));
  });

  await test('markdown format: renders through the markdown path (regression)', () => {
    const html = render(base({ format: 'markdown', content: '# Heading\n\nSome **bold** text.' }));
    assert.ok(html.includes('<h1'), 'markdown headings should render as heading elements');
    assert.ok(html.includes('<strong'), 'markdown bold should render as a strong element');
    assert.ok(!html.includes('<pre'), 'markdown should not fall through to the raw <pre> renderer');
  });

  await test('unset format: defaults to the markdown path (regression)', () => {
    const html = render(base({ content: '# Heading' }));
    assert.ok(html.includes('<h1'));
  });

  await test('markdown format: frontmatter renders null placeholder for empty values and joins JSON arrays', () => {
    const content = '---\nrating: null\ntags: ["a","b"]\n---\n# Heading';
    const html = render(base({ format: 'markdown', content }));
    assert.ok(html.includes('class="md-fm-null"'), 'empty/null frontmatter value should get the md-fm-null placeholder');
    assert.ok(html.includes('>null<'), 'the placeholder text itself should read "null"');
    assert.ok(html.includes('a, b'), 'a JSON-array frontmatter value should render as comma-separated text');
    assert.ok(!html.includes('[&quot;a&quot;,&quot;b&quot;]'), 'the raw JSON array text should not be rendered verbatim');
  });
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
