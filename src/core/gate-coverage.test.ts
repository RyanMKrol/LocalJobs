// Whole-repo invariant: every workflow is on ports, and every DAG edge in it
// carries data (it feeds a declared input of the downstream stage with an
// artifact the upstream stage really outputs). The registry enforces the same
// thing when it loads; this asserts it in the suite with every problem listed,
// plus a pair of synthetic cases that prove the checker itself notices a hole.
import assert from 'node:assert/strict';
import { jobs, workflows } from '../workflows/registry.js';
import { acceptAny, defineStage, jsonArtifact, validateWorkflowContracts, workflowMode } from '../engine/ports.js';
import type { JobDefinition } from '../engine/types.js';

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
}

// ─────────────────────────── real-registry walk ───────────────────────────

test('every workflow in the registry has a contract on every DAG edge', () => {
  // The SAME check the registry runs at load (`validateWorkflowContracts`): every
  // edge must carry a declared input the upstream stage really outputs. Asserted
  // here too so a contract hole fails the suite with every problem listed.
  const jobsByName = new Map(jobs.map((j) => [j.name, j]));
  const problems: string[] = [];
  for (const workflow of workflows) {
    for (const ref of workflow.jobs) {
      assert.ok(jobsByName.get(ref.job), `workflow '${workflow.name}': member job '${ref.job}' not found in registry`);
    }
    for (const e of validateWorkflowContracts(workflow, (n) => jobsByName.get(n))) problems.push(`workflow '${workflow.name}': ${e}`);
  }
  assert.deepEqual(problems, [], `contract problems:\n${problems.join('\n')}\n(see src/workflows/CLAUDE.md)`);
});

test('every workflow in the registry is on ports: every stage declares its inputs and outputs', () => {
  const jobsByName = new Map(jobs.map((j) => [j.name, j]));
  const legacy = workflows.filter((w) => workflowMode(w, (n) => jobsByName.get(n)) !== 'ports').map((w) => w.name);
  assert.deepEqual(legacy, [], `workflows not on ports: ${legacy.join(', ')}`);
  const undeclared = jobs.filter((j) => !j.outputs).map((j) => j.name);
  assert.deepEqual(undeclared, [], `stages that declare no outputs: ${undeclared.join(', ')}`);
  assert.ok(workflows.length >= 23, `expected the 23 shipped workflows, found ${workflows.length}`);
});

// ─────────────────────────── the checker itself ───────────────────────────

const run = async () => {};
const thing = jsonArtifact<{ n: number }>({ key: 'gc-thing', description: 'A thing.', check: acceptAny });
const producer = defineStage({ name: 'gc-producer', outputs: { thing: { artifact: thing, location: '/tmp/gc-thing.json' } }, run });
const lookup = (...defs: JobDefinition[]) => (n: string) => defs.find((d) => d.name === n);
const edge = { name: 'gc-wf', jobs: [{ job: 'gc-producer' }, { job: 'gc-consumer', dependsOn: ['gc-producer'] }] };

test('an edge that feeds a declared input passes, with the least an artifact can declare (a check that accepts anything)', () => {
  const consumer = defineStage({ name: 'gc-consumer', inputs: { thing: { artifact: thing } }, run });
  assert.deepEqual(validateWorkflowContracts(edge, lookup(producer, consumer)), []);
});

test('an edge that carries no data is genuinely detected (regression guard for the checker itself)', () => {
  const consumer = defineStage({ name: 'gc-consumer', run });
  const problems = validateWorkflowContracts(edge, lookup(producer, consumer));
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], /gc-producer/);
});

console.log(`\n${passed} gate-coverage test(s) passed`);
