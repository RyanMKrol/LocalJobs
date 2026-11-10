// The run page's Inputs & Outputs, derived from what the engine recorded.
//
// Seeds the records directly (artifacts, resolved inputs, per-run item snapshots)
// rather than running stages, so each rule is tested in isolation:
//   - a stage's outputs are attributed by the ATTEMPT that wrote them, not by
//     ledger name (the bug `outputJob` used to paper over)
//   - only items the run CHANGED are listed; identical re-records are counted
//   - a stage's inputs are the artifacts it was handed plus the upstream items it
//     actually worked on, whenever those were written
//   - an old run keeps showing what it recorded after a later run overwrites the ledger
//   - a legacy run still renders, through the frozen legacy mapping
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acceptAny, defineStage, inlineArtifact, jsonArtifact } from './ports.js';
import type { JobDefinition, WorkflowDefinition } from './types.js';
import {
  createRun, createWorkflowRun, finishRun, getWorkflowRun, ledgersWrittenByJob, markWorkItem, recordRunArtifact, recordRunInput,
  setRunInputUsed, syncJob, syncWorkflow,
} from '../db/store.js';
import { sha256File } from './hash.js';
import { statSync } from 'node:fs';
import { OVERALL, artifactItems, latestProductArtifacts, productStages, stageIo } from './reporting.js';

const dir = mkdtempSync(join(tmpdir(), 'lj-stageio-'));
const page = { limit: 100, inputsOffset: 0, outputsOffset: 0 };

interface Snap { shows: { id: number; title: string }[] }
const snapshotArt = jsonArtifact<Snap>({
  key: 'sio-snapshot',
  description: 'The library snapshot.',
  check: acceptAny,
  summary: (v) => `${v.shows.length} show(s)`,
  items: (v) => v.shows.map((s) => ({ id: String(s.id), title: s.title, fields: [{ label: 'TMDB', value: String(s.id) }] })),
});
const digestArt = inlineArtifact<{ sent: number }>({ key: 'sio-digest', description: 'What was announced.', check: acceptAny });

const run = async () => {};
const snapshotStage = defineStage({ name: 'sio-snap', outputs: { snapshot: { artifact: snapshotArt, location: join(dir, 'snapshot.json') } }, run });
const pickStage = defineStage({
  name: 'sio-pick',
  inputs: { snapshot: { artifact: snapshotArt } },
  outputs: { digest: { artifact: digestArt } },
  describeItem: (d) => ({
    title: String(d.name),
    fields: [{ label: 'Lens', value: String(d.lens) }],
    preview: typeof d.markdown === 'string' ? { path: d.markdown, format: 'markdown' } : undefined,
  }),
  run,
});
const defs: JobDefinition[] = [snapshotStage, pickStage];
const getJob = (n: string) => defs.find((d) => d.name === n);
const wf: WorkflowDefinition = { name: 'sio-wf', jobs: [{ job: 'sio-snap' }, { job: 'sio-pick', dependsOn: ['sio-snap'] }] };
for (const d of defs) syncJob(d);
syncWorkflow(wf);

/** Seed one complete ports run: snapshot stage commits a file; pick stage reads it and announces items. */
function seedRun(shows: Snap['shows'], picks: { key: string; name: string; lens: string }[]) {
  const wfRun = createWorkflowRun('sio-wf', 'manual');
  const file = join(dir, 'snapshot.json');
  writeFileSync(file, JSON.stringify({ shows }));
  const st = statSync(file);

  const snapRun = createRun('sio-snap', 'workflow', 1, wfRun, { cycle: 1 });
  const artifactId = recordRunArtifact({
    workflowRunId: wfRun, runId: snapRun, cycle: 1, jobName: 'sio-snap', port: 'snapshot', artifactKey: 'sio-snapshot',
    storage: 'json', path: file, sha256: sha256File(file), bytes: st.size, mtimeMs: st.mtimeMs, itemCount: shows.length,
    fresh: true, ok: true, check: { ok: true }, summary: { summary: `${shows.length} show(s)`, items: snapshotArt.items!({ shows }) },
  });
  finishRun(snapRun, 'success');

  recordRunInput({ workflowRunId: wfRun, cycle: 1, jobName: 'sio-pick', port: 'snapshot', producerJob: 'sio-snap', artifactKey: 'sio-snapshot', artifactId, ok: true });
  const pickRun = createRun('sio-pick', 'workflow', 1, wfRun, { cycle: 1 });
  for (const p of picks) {
    // Written under a SHARED ledger name ('sio-recs'), not the stage's own.
    markWorkItem('sio-recs', p.key, 'success', { detail: { name: p.name, lens: p.lens }, workflowRunId: wfRun, runId: pickRun });
  }
  recordRunArtifact({
    workflowRunId: wfRun, runId: pickRun, cycle: 1, jobName: 'sio-pick', port: 'digest', artifactKey: 'sio-digest',
    storage: 'inline', inlineJson: JSON.stringify({ sent: picks.length }), fresh: true, ok: true, check: { ok: true },
  });
  finishRun(pickRun, 'success');
  return { wfRun, pickRun, snapRun, artifactId, file };
}

test('ports: a stage shows the artifacts it was handed and committed, and the items its own attempt wrote (whatever the ledger name)', () => {
  const { wfRun, artifactId } = seedRun(
    [{ id: 1, title: 'One' }, { id: 2, title: 'Two' }],
    [{ key: 'tmdb-9', name: 'Severance', lens: 'canon' }],
  );
  const io = stageIo(getJob, getWorkflowRun(wfRun)!, 'sio-pick', page)!;
  assert.equal(io.mode, 'ports');
  assert.deepEqual(io.predecessorJobs, ['sio-snap']);

  // Input: the snapshot artifact, as resolved for this stage.
  assert.equal(io.inputs.artifacts.length, 1);
  const input = io.inputs.artifacts[0];
  assert.equal(input.id, artifactId);
  assert.equal(input.job, 'sio-snap');
  assert.equal(input.consumerPort, 'snapshot');
  assert.deepEqual(input.resolved, { ok: true, reason: null });
  assert.equal(input.summary, '2 show(s)');
  assert.equal(input.itemCount, 2);
  assert.equal(input.description, 'The library snapshot.');
  assert.deepEqual(input.sample.map((s) => s.title), ['One', 'Two']);
  assert.deepEqual(input.preview?.format, 'json');

  // Output: the inline digest, and the announced item, described by the stage.
  assert.deepEqual(io.outputs.artifacts.map((a) => [a.port, a.inline]), [['digest', { sent: 1 }]]);
  assert.equal(io.outputs.itemTotal, 1);
  const item = io.outputs.items[0];
  assert.equal(item.jobName, 'sio-recs', 'the row keeps its ledger name');
  assert.equal(item.title, 'Severance');
  assert.deepEqual(item.fields, [{ label: 'Lens', value: 'canon' }], 'explicit fields from describeItem, nothing inferred');
  assert.equal(item.status, 'success');
});

test('ports: `used()` items are attached to the input they came from', () => {
  const { wfRun } = seedRun([{ id: 1, title: 'One' }, { id: 2, title: 'Two' }, { id: 3, title: 'Three' }], []);
  setRunInputUsed(wfRun, 1, 'sio-pick', 'snapshot', 'sio-snap', { total: 1, items: [{ id: '2', title: 'Two' }] });
  const io = stageIo(getJob, getWorkflowRun(wfRun)!, 'sio-pick', page)!;
  assert.deepEqual(io.inputs.artifacts[0].used, { total: 1, items: [{ id: '2', title: 'Two' }] });
});

test('ports: only items the run CHANGED are listed; identical re-records are counted, not shown', () => {
  const first = seedRun([{ id: 1, title: 'One' }], [{ key: 'a', name: 'A', lens: 'x' }, { key: 'b', name: 'B', lens: 'x' }]);
  assert.equal(stageIo(getJob, getWorkflowRun(first.wfRun)!, 'sio-pick', page)!.outputs.itemTotal, 2);
  // A second run re-records `a` identically and changes `b`.
  const second = seedRun([{ id: 1, title: 'One' }], [{ key: 'a', name: 'A', lens: 'x' }, { key: 'b', name: 'B', lens: 'changed' }]);
  const io = stageIo(getJob, getWorkflowRun(second.wfRun)!, 'sio-pick', page)!;
  assert.deepEqual(io.outputs.items.map((i) => i.itemKey), ['b']);
  assert.equal(io.outputs.unchangedCount, 1);
});

test('ports: an old run still shows what IT recorded after a later run overwrites the ledger', () => {
  const first = seedRun([{ id: 1, title: 'One' }], [{ key: 'hist', name: 'Original', lens: 'first' }]);
  seedRun([{ id: 1, title: 'One' }], [{ key: 'hist', name: 'Rewritten', lens: 'second' }]);
  const io = stageIo(getJob, getWorkflowRun(first.wfRun)!, 'sio-pick', page)!;
  assert.equal(io.outputs.items[0].title, 'Original');
  assert.deepEqual(io.outputs.items[0].fields, [{ label: 'Lens', value: 'first' }]);
});

test("ports: a stage's item inputs are the upstream items it worked on, even ones written by an earlier run", () => {
  const worker = defineStage({ name: 'sio-worker', inputs: { snapshot: { artifact: snapshotArt } }, outputs: { digest: { artifact: digestArt } }, run });
  defs.push(worker);
  syncJob(worker);
  const wf2: WorkflowDefinition = { name: 'sio-wf2', jobs: [{ job: 'sio-snap' }, { job: 'sio-worker', dependsOn: ['sio-snap'] }] };
  syncWorkflow(wf2);

  // An EARLIER run recorded the upstream item.
  const earlier = createWorkflowRun('sio-wf2', 'manual');
  markWorkItem('sio-snap', 'old-item', 'success', { detail: { name: 'From an earlier run' }, workflowRunId: earlier, runId: createRun('sio-snap', 'workflow', 1, earlier) });

  // This run records one upstream item itself, and works on both.
  const wfRun = createWorkflowRun('sio-wf2', 'manual');
  const up = createRun('sio-snap', 'workflow', 1, wfRun);
  markWorkItem('sio-snap', 'new-item', 'success', { detail: { name: 'From this run' }, workflowRunId: wfRun, runId: up });
  finishRun(up, 'success');
  const w = createRun('sio-worker', 'workflow', 1, wfRun);
  markWorkItem('sio-worker', 'old-item', 'success', { from: { job: 'sio-snap' }, detail: { name: 'worked old' }, workflowRunId: wfRun, runId: w });
  markWorkItem('sio-worker', 'new-item', 'failed', { from: { job: 'sio-snap' }, detail: { name: 'worked new' }, workflowRunId: wfRun, runId: w });
  recordRunArtifact({ workflowRunId: wfRun, runId: w, cycle: 1, jobName: 'sio-worker', port: 'digest', artifactKey: 'sio-digest', storage: 'inline', inlineJson: '{"sent":0}', fresh: true, ok: true });
  finishRun(w, 'failed');

  const io = stageIo(getJob, getWorkflowRun(wfRun)!, 'sio-worker', page)!;
  assert.deepEqual(io.inputs.items.map((i) => [i.itemKey, i.title]), [['new-item', 'From this run'], ['old-item', 'From an earlier run']]);
  assert.equal(io.inputs.itemTotal, 2);
  assert.deepEqual(io.outputs.items.map((i) => [i.itemKey, i.status]), [['new-item', 'failed'], ['old-item', 'success']]);
});

test('ports: an input the engine could not resolve is still shown, with the reason', () => {
  const wfRun = createWorkflowRun('sio-wf', 'manual');
  const snapRun = createRun('sio-snap', 'workflow', 1, wfRun);
  recordRunArtifact({ workflowRunId: wfRun, runId: snapRun, cycle: 1, jobName: 'sio-snap', port: 'other', artifactKey: 'x', storage: 'inline', inlineJson: '1', fresh: true, ok: true });
  finishRun(snapRun, 'success');
  recordRunInput({ workflowRunId: wfRun, cycle: 1, jobName: 'sio-pick', port: 'snapshot', producerJob: 'sio-snap', artifactKey: 'sio-snapshot', ok: false, reason: '"sio-snap" succeeded but committed no "sio-snapshot" artifact in this run' });
  const io = stageIo(getJob, getWorkflowRun(wfRun)!, 'sio-pick', page)!;
  assert.equal(io.inputs.artifacts.length, 1);
  assert.equal(io.inputs.artifacts[0].resolved?.ok, false);
  assert.match(io.inputs.artifacts[0].resolved?.reason ?? '', /committed no "sio-snapshot" artifact/);
  assert.equal(io.inputs.artifacts[0].description, 'The library snapshot.', 'described from the consumer port when there is no artifact');
});

test('ports: Overall shows what the root stage gathered and what the final stage produced', () => {
  const { wfRun } = seedRun([{ id: 1, title: 'One' }], [{ key: 'ov', name: 'Overall pick', lens: 'x' }]);
  const io = stageIo(getJob, getWorkflowRun(wfRun)!, OVERALL, page)!;
  assert.deepEqual(io.predecessorJobs, ['sio-snap']);
  assert.deepEqual(io.outputJobs, ['sio-pick']);
  assert.deepEqual(io.inputs.artifacts.map((a) => `${a.job}.${a.port}`), ['sio-snap.snapshot']);
  assert.deepEqual(io.outputs.artifacts.map((a) => `${a.job}.${a.port}`), ['sio-pick.digest']);
  assert.deepEqual(io.outputs.items.map((i) => i.title), ['Overall pick']);
});

test('artifact items are computed on demand while the file is still the one committed; a changed file returns the stored sample, flagged', () => {
  const shows = Array.from({ length: 120 }, (_, i) => ({ id: i + 1, title: `Show ${i + 1}` }));
  const { wfRun, artifactId, file } = seedRun(shows, []);
  const first = artifactItems(getJob, wfRun, artifactId, 50, 100);
  assert.equal(first.total, 120);
  assert.equal(first.items.length, 20, 'paged: items 101-120');
  assert.equal(first.items[0].title, 'Show 101');
  assert.equal(first.changedSinceRun, false);
  assert.equal(first.sampleOnly, false);

  // A later run rewrites the file: its contents no longer describe THIS run.
  writeFileSync(file, JSON.stringify({ shows: [{ id: 999, title: 'From a later run' }] }));
  const later = artifactItems(getJob, wfRun, artifactId, 50, 0);
  assert.equal(later.changedSinceRun, true);
  assert.equal(later.sampleOnly, true);
  assert.equal(later.items[0].title, 'Show 1', 'the stored sample from commit time, not the later contents');
  assert.equal(later.total, 120);

  assert.equal(artifactItems(getJob, 'some-other-run', artifactId, 50, 0).found, false, 'an artifact is only served for its own run');
});

test('legacy: a run with no artifacts renders through the frozen mapping (predecessor rows as inputs, inferred fields)', () => {
  const a: JobDefinition = { name: 'sio-legacy-a', run };
  const b: JobDefinition = { name: 'sio-legacy-b', run };
  syncJob(a); syncJob(b);
  const lwf: WorkflowDefinition = { name: 'sio-legacy-wf', jobs: [{ job: 'sio-legacy-a' }, { job: 'sio-legacy-b', dependsOn: ['sio-legacy-a'] }] };
  syncWorkflow(lwf);
  const wfRun = createWorkflowRun('sio-legacy-wf', 'manual');
  markWorkItem('sio-legacy-a', 'in-1', 'success', { detail: { name: 'Input one', tmdbId: 7, nested: { x: 1 } }, workflowRunId: wfRun });
  markWorkItem('sio-legacy-b', 'out-1', 'success', { detail: { name: 'Output one', markdown: '/tmp/x.md' }, workflowRunId: wfRun });

  const io = stageIo(() => undefined, getWorkflowRun(wfRun)!, 'sio-legacy-b', page)!;
  assert.equal(io.mode, 'legacy');
  assert.deepEqual(io.inputs.artifacts, []);
  assert.deepEqual(io.inputs.items.map((i) => [i.title, i.fields]), [['Input one', [{ label: 'Tmdb Id', value: '7' }]]]);
  assert.deepEqual(io.outputs.items[0].preview, { path: '/tmp/x.md', format: 'markdown' });

  // The per-run snapshot keeps a legacy run's page honest too.
  const later = createWorkflowRun('sio-legacy-wf', 'manual');
  markWorkItem('sio-legacy-b', 'out-1', 'failed', { detail: { name: 'Overwritten later' }, workflowRunId: later });
  const again = stageIo(() => undefined, getWorkflowRun(wfRun)!, 'sio-legacy-b', page)!;
  assert.equal(again.outputs.items[0].title, 'Output one');
  assert.equal(again.outputs.items[0].status, 'success');

  assert.equal(stageIo(() => undefined, getWorkflowRun(wfRun)!, 'not-a-member', page), null);
});

test.after(() => rmSync(dir, { recursive: true, force: true }));

test('the workflow page: a workflow\'s product is the latest artifact of each output of its product stage, and that stage\'s ledgers', () => {
  assert.deepEqual(productStages(wf.jobs, getJob), ['sio-pick'], 'with nothing marked `product`, the final stage');
  const marked = defineStage({ ...snapshotStage, product: true, run });
  assert.deepEqual(
    productStages(wf.jobs, (n) => (n === 'sio-snap' ? marked : getJob(n))),
    ['sio-snap'],
    'a stage marked `product` wins over the final stage',
  );

  seedRun([{ id: 1, title: 'One' }], [{ key: 'tmdb-1', name: 'First', lens: 'canon' }]);
  const latest = seedRun([{ id: 1, title: 'One' }], [{ key: 'tmdb-2', name: 'Second', lens: 'canon' }, { key: 'tmdb-3', name: 'Third', lens: 'world' }]);

  const cards = latestProductArtifacts(getJob, ['sio-pick']);
  assert.equal(cards.length, 1, 'one card per output port, not one per run');
  assert.equal(cards[0].port, 'digest');
  assert.deepEqual(cards[0].inline, { sent: 2 }, 'the most recent run\'s value');
  assert.equal(cards[0].workflowRunId, latest.wfRun, 'and which run committed it, so its items can be browsed');

  assert.deepEqual(ledgersWrittenByJob('sio-pick').sort(), ['sio-pick', 'sio-recs'], 'the shared ledger its attempts wrote to is found');
});
