// Tests for the work-items store helpers. Runs against the scratch DB set by
// `npm test` (LOCALJOBS_DB). Self-asserting: throws on failure.
import assert from 'node:assert/strict';
import {
  createWorkflowRun,
  listSuccessWorkItems,
  markWorkItem,
  stageIoLists,
  syncJob,
  syncWorkflow,
  workflowTerminalItems,
  workflowTerminalItemsCount,
} from '../store.js';

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

// listSuccessWorkItems: only success rows for the named job, ordered by key,
// detail intact (with path keys normalized by markWorkItem as usual).
markWorkItem(JOB, 't616-failed', 'failed', { detail: { name: 'Broken item', error: 'boom' } });
syncJob({ name: 't616-other-job', run: async () => {} });
markWorkItem('t616-other-job', 't616-elsewhere', 'success', { detail: { name: 'Other job item' } });

const successes = listSuccessWorkItems(JOB);
assert.deepEqual(successes.map((r) => r.item_key), ['t616-json', 't616-markdown', 't616-plain']);
assert.ok(successes.every((r) => r.status === 'success' && r.job_name === JOB));
const md = successes.find((r) => r.item_key === 't616-markdown');
assert.equal(JSON.parse(md!.detail!).name, 'Markdown item');
assert.ok(md!.updated_at);

// ── stageIoLists paging: totals + disjoint pages + SQL-side input-sample routing ──
// A 27k-item run (plex-rename) froze the browser when the endpoint shipped the
// full lists; the store now pages in SQL, with per-side totals, and the T615
// input-sample routing applied IN SQL so offsets never skip or duplicate rows.
{
  syncJob({ name: 'page-a', run: async () => {} });
  syncJob({ name: 'page-b', run: async () => {} });
  syncWorkflow({ name: 'page-wf', jobs: [{ job: 'page-a' }, { job: 'page-b', dependsOn: ['page-a'] }] });
  const runP = createWorkflowRun('page-wf', 'manual');

  for (let i = 0; i < 5; i++) {
    markWorkItem('page-a', `in-${String(i).padStart(3, '0')}`, 'success', { workflowRunId: runP, detail: { name: `in ${i}` } });
  }
  for (let i = 0; i < 250; i++) {
    markWorkItem('page-b', `out-${String(i).padStart(3, '0')}`, 'success', { workflowRunId: runP, detail: { name: `out ${i}` } });
  }
  // Self-recorded input samples under the OUTPUT job — must surface as inputs, never outputs.
  for (let i = 0; i < 3; i++) {
    markWorkItem('page-b', `sample-${i}`, 'success', { workflowRunId: runP, detail: { kind: 'input-sample', name: `sample ${i}` } });
  }

  // Unpaged: full lists + matching totals.
  const full = stageIoLists(['page-b'], ['page-a'], runP);
  assert.equal(full.outputs.length, 250);
  assert.equal(full.outputTotal, 250);
  assert.equal(full.inputs.length, 8, '5 predecessor rows + 3 self input-samples');
  assert.equal(full.inputTotal, 8);
  assert.ok(full.outputs.every((o) => !String(o.itemKey).startsWith('sample-')), 'samples never in outputs');

  // Paged: totals independent of page size; pages disjoint and covering.
  const p1 = stageIoLists(['page-b'], ['page-a'], runP, { limit: 100, inputsOffset: 0, outputsOffset: 0 });
  assert.equal(p1.outputs.length, 100);
  assert.equal(p1.outputTotal, 250, 'total unaffected by the page size');
  assert.equal(p1.inputs.length, 8, 'a side smaller than the limit arrives whole');
  const p3 = stageIoLists(['page-b'], ['page-a'], runP, { limit: 100, inputsOffset: 8, outputsOffset: 200 });
  assert.equal(p3.outputs.length, 50, 'the final page is the remainder');
  assert.equal(p3.inputs.length, 0, 'an exhausted side pages empty');
  const p2 = stageIoLists(['page-b'], ['page-a'], runP, { limit: 100, inputsOffset: 0, outputsOffset: 100 });
  const allKeys = new Set([...p1.outputs, ...p2.outputs, ...p3.outputs].map((o) => o.itemKey));
  assert.equal(allKeys.size, 250, 'pages are disjoint and cover every row exactly once');
}

// ── workflowTerminalItems paging: totals + disjoint pages (Output section lazy load) ──
{
  const total = workflowTerminalItemsCount([JOB]);
  assert.equal(total, 3, 'count matches the success rows');
  const page1 = workflowTerminalItems([JOB], { limit: 2, offset: 0 });
  const page2 = workflowTerminalItems([JOB], { limit: 2, offset: 2 });
  assert.equal(page1.length, 2);
  assert.equal(page2.length, 1);
  const keys = new Set([...page1, ...page2].map((i) => i.itemKey));
  assert.equal(keys.size, 3, 'pages are disjoint and cover every item');
  assert.equal(workflowTerminalItemsCount([]), 0);
}

console.log('workItems.test.ts: ok');
