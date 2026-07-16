// Tests for the work-items store helpers. Runs against the scratch DB set by
// `npm test` (LOCALJOBS_DB). Self-asserting: throws on failure.
import assert from 'node:assert/strict';
import { markWorkItem, syncJob, workflowTerminalItems } from '../store.js';

const JOB = 't616-output-job';
syncJob({ name: JOB, run: async () => {} });

// Legacy markdown form -> viewable true, hasMarkdown true.
markWorkItem(JOB, 't616-markdown', 'success', {
  detail: { name: 'Markdown item', markdown: '/x/data/out/p.md' },
});

// T262 format+path form (e.g. JSON) -> viewable true, hasMarkdown false.
markWorkItem(JOB, 't616-json', 'success', {
  detail: { name: 'JSON item', format: 'json', path: '/x/data/out/report.json' },
});

// Neither markdown nor a complete format+path pair -> not viewable.
markWorkItem(JOB, 't616-plain', 'success', {
  detail: { name: 'Plain item' },
});

const items = workflowTerminalItems([JOB]);
const byKey = Object.fromEntries(items.map((i) => [i.itemKey, i]));

assert.equal(byKey['t616-markdown'].hasMarkdown, true);
assert.equal(byKey['t616-markdown'].viewable, true);

assert.equal(byKey['t616-json'].hasMarkdown, false);
assert.equal(byKey['t616-json'].viewable, true);

assert.equal(byKey['t616-plain'].hasMarkdown, false);
assert.equal(byKey['t616-plain'].viewable, false);

console.log('workItems.test.ts: ok');
