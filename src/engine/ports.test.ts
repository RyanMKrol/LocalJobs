// The binding rules: which upstream stage feeds each input, and every way a
// workflow's ports can fail to line up. These errors stop the daemon at load.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptAny, bindWorkflowPorts, defineStage, inlineArtifact, isPortsJob, jsonArtifact, portGates, validateWorkflowContracts, workflowMode } from './ports.js';
import type { JobDefinition, WorkflowDefinition } from './types.js';

const art = (key: string) => jsonArtifact<unknown>({ key, description: key, check: acceptAny });
const A = art('a');
const B = art('b');
const run = async () => {};

function lookup(...defs: JobDefinition[]) {
  return (name: string) => defs.find((d) => d.name === name);
}
const wf = (jobs: WorkflowDefinition['jobs']): WorkflowDefinition => ({ name: 'w', jobs });

test('a plain input binds to the one direct dependency that outputs its artifact', () => {
  const p = defineStage({ name: 'p', outputs: { out: { artifact: A, location: '/x' } }, run });
  const c = defineStage({ name: 'c', inputs: { in: { artifact: A } }, run });
  const { bindings, errors } = bindWorkflowPorts(wf([{ job: 'p' }, { job: 'c', dependsOn: ['p'] }]), lookup(p, c));
  assert.deepEqual(errors, []);
  assert.deepEqual(bindings, [{ consumer: 'c', port: 'in', producer: 'p', producerPort: 'out', artifactKey: 'a', many: false }]);
});

test('a fan-in (many) input binds to EVERY direct dependency that outputs the artifact, in manifest order', () => {
  const b1 = defineStage({ name: 'b1', outputs: { o: { artifact: A, location: '/1' } }, run });
  const b2 = defineStage({ name: 'b2', outputs: { o: { artifact: A, location: '/2' } }, run });
  const b3 = defineStage({ name: 'b3', outputs: { o: { artifact: A, location: '/3' } }, run });
  const m = defineStage({ name: 'm', inputs: { parts: { artifact: A, many: true } }, run });
  const { bindings, errors } = bindWorkflowPorts(
    wf([{ job: 'b1' }, { job: 'b2' }, { job: 'b3' }, { job: 'm', dependsOn: ['b1', 'b2', 'b3'] }]),
    lookup(b1, b2, b3, m),
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(bindings.map((b) => b.producer), ['b1', 'b2', 'b3']);
  assert.ok(bindings.every((b) => b.many && b.port === 'parts'));
});

test('several inputs: a stage can take a fan-in AND a single input from different stages', () => {
  const s = defineStage({ name: 's', outputs: { o: { artifact: B, location: '/s' } }, run });
  const b1 = defineStage({ name: 'b1', inputs: { s: { artifact: B } }, outputs: { o: { artifact: A, location: '/1' } }, run });
  const b2 = defineStage({ name: 'b2', inputs: { s: { artifact: B } }, outputs: { o: { artifact: A, location: '/2' } }, run });
  const m = defineStage({ name: 'm', inputs: { parts: { artifact: A, many: true }, source: { artifact: B } }, run });
  const def = wf([{ job: 's' }, { job: 'b1', dependsOn: ['s'] }, { job: 'b2', dependsOn: ['s'] }, { job: 'm', dependsOn: ['s', 'b1', 'b2'] }]);
  const { bindings, errors } = bindWorkflowPorts(def, lookup(s, b1, b2, m));
  assert.deepEqual(errors, []);
  assert.deepEqual(bindings.filter((b) => b.consumer === 'm').map((b) => `${b.port}<-${b.producer}`), ['parts<-b1', 'parts<-b2', 'source<-s']);
  assert.deepEqual(portGates(def, lookup(s, b1, b2, m)).length, bindings.length, 'one gate per binding');
});

test('an input whose artifact is output only by a NON-direct ancestor is an error that says to add the edge', () => {
  const s = defineStage({ name: 's', outputs: { o: { artifact: B, location: '/s' } }, run });
  const mid = defineStage({ name: 'mid', inputs: { s: { artifact: B } }, outputs: { o: { artifact: A, location: '/m' } }, run });
  const end = defineStage({ name: 'end', inputs: { a: { artifact: A }, hidden: { artifact: B } }, run });
  const { errors } = bindWorkflowPorts(wf([{ job: 's' }, { job: 'mid', dependsOn: ['s'] }, { job: 'end', dependsOn: ['mid'] }]), lookup(s, mid, end));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /"end" input "hidden" needs artifact "b"/);
  assert.match(errors[0], /"s" does: add it to dependsOn/);
});

test('a plain input fed by two stages is ambiguous; `from` picks one', () => {
  const b1 = defineStage({ name: 'b1', outputs: { o: { artifact: A, location: '/1' } }, run });
  const b2 = defineStage({ name: 'b2', outputs: { o: { artifact: A, location: '/2' } }, run });
  const jobs: WorkflowDefinition['jobs'] = [{ job: 'b1' }, { job: 'b2' }, { job: 'c', dependsOn: ['b1', 'b2'] }];
  const ambiguous = defineStage({ name: 'c', inputs: { in: { artifact: A } }, run });
  assert.match(bindWorkflowPorts(wf(jobs), lookup(b1, b2, ambiguous)).errors[0], /is fed by 2 stages \(b1, b2\)/);

  // Picking b1 resolves the ambiguity, but then the b2 edge carries nothing.
  const picked = defineStage({ name: 'c', inputs: { in: { artifact: A, from: 'b1' } }, run });
  const r = bindWorkflowPorts(wf(jobs), lookup(b1, b2, picked));
  assert.deepEqual(r.bindings.map((b) => b.producer), ['b1']);
  assert.deepEqual(r.errors, ['edge b2 → c carries no data: "c" declares no input fed by "b2" (declare one, or remove the edge)']);
});

test('every edge must carry data: a dependency that feeds no input is an error', () => {
  const p = defineStage({ name: 'p', outputs: { o: { artifact: A, location: '/p' } }, run });
  const c = defineStage({ name: 'c', run });
  assert.match(bindWorkflowPorts(wf([{ job: 'p' }, { job: 'c', dependsOn: ['p'] }]), lookup(p, c)).errors[0], /edge p → c carries no data/);
});

test('`from` naming a stage that is not a dependency, or that does not output the artifact, is an error', () => {
  const p = defineStage({ name: 'p', outputs: { o: { artifact: A, location: '/p' } }, run });
  const q = defineStage({ name: 'q', outputs: { o: { artifact: B, location: '/q' } }, run });
  const c = defineStage({ name: 'c', inputs: { x: { artifact: A, from: ['p', 'q', 'nope'] }, y: { artifact: B } }, run });
  const { errors } = bindWorkflowPorts(wf([{ job: 'p' }, { job: 'q' }, { job: 'c', dependsOn: ['p', 'q'] }]), lookup(p, q, c));
  assert.ok(errors.some((e) => /names "nope" in `from`, which is not one of its dependsOn/.test(e)));
  assert.ok(errors.some((e) => /names "q" in `from`, which does not output artifact "a"/.test(e)));
});

test('a stage may not output the same artifact twice, and a file-backed output needs a location', () => {
  const p = defineStage({ name: 'p', outputs: { one: { artifact: A, location: '/1' }, two: { artifact: A, location: '/2' }, bare: { artifact: B } }, run });
  const { errors } = bindWorkflowPorts(wf([{ job: 'p' }]), lookup(p));
  assert.ok(errors.some((e) => /outputs artifact "a" twice/.test(e)));
  assert.ok(errors.some((e) => /output "bare" \(json artifact "b"\) has no location/.test(e)));
});

test('inline and ledger outputs need no location', () => {
  const p = defineStage({ name: 'p', outputs: { n: { artifact: inlineArtifact<number>({ key: 'n', description: 'n', check: acceptAny }) } }, run });
  assert.deepEqual(bindWorkflowPorts(wf([{ job: 'p' }]), lookup(p)).errors, []);
});

test('a workflow is all ports or none: mixing in a stage with no ports is an error', () => {
  const p = defineStage({ name: 'p', outputs: { o: { artifact: A, location: '/p' } }, run });
  const plain: JobDefinition = { name: 'old', run };
  const def = wf([{ job: 'p' }, { job: 'old', dependsOn: ['p'] }]);
  assert.equal(workflowMode(def, lookup(p, plain)), 'ports');
  assert.match(validateWorkflowContracts(def, lookup(p, plain))[0], /mixes ports stages with stages that declare no ports \(old\)/);
});

test('a workflow with no ports at all has nothing to validate here (the registry refuses it for that alone)', () => {
  const p: JobDefinition = { name: 'p', run };
  const c: JobDefinition = { name: 'c', run };
  const def = wf([{ job: 'p' }, { job: 'c', dependsOn: ['p'] }]);
  assert.equal(workflowMode(def, lookup(p, c)), 'legacy');
  assert.deepEqual(validateWorkflowContracts(def, lookup(p, c)), []);
});

test('defineStage marks a job as a ports stage even with no ports, and refuses a plain context', async () => {
  const s = defineStage({ name: 's', run });
  assert.equal(isPortsJob(s), true);
  assert.equal(isPortsJob({ }), false);
  await assert.rejects(
    async () => s.run({ log() {}, progress() {}, selectedRoots: () => null, rootAllowed: () => true }),
    /declares ports and must be run by the workflow engine/,
  );
});
