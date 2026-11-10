// Whole-repo invariant: every adjacent job pair (DAG edge) in every workflow must
// have a matching produces/consumes validation gate between them (see root
// CLAUDE.md's "Validation gates between workflow stages" section). This is the
// mechanical enforcement of that convention — a future workflow shipped without
// gates on some edge must fail `npm test`, not just leave a dashboard gap someone
// happens to notice. Complements dag.test.ts (pure DAG mechanics) and
// contracts.test.ts (individual real contracts) with the cross-cutting check.
import assert from 'node:assert/strict';
import { buildDag, deriveGates } from '../engine/dag.js';
import type { Dag } from '../engine/dag.js';
import { jobs, workflows } from '../workflows/registry.js';
import { validateWorkflowContracts, workflowMode } from '../engine/ports.js';

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

/**
 * Every DAG edge (producer → consumer) that has NO matching gate in
 * `deriveGates(dag, produces, consumes)`. Shared by the real-registry walk and
 * the synthetic pass/fail unit tests below so both exercise identical logic.
 */
function missingGateEdges(
  dag: Dag,
  produces: Map<string, string[]>,
  consumes: Map<string, string[]>,
): { producer: string; consumer: string }[] {
  const gateKeys = new Set(deriveGates(dag, produces, consumes).map((g) => `${g.producer}->${g.consumer}`));
  const missing: { producer: string; consumer: string }[] = [];
  for (const consumer of dag.nodes) {
    for (const producer of dag.dependencies.get(consumer)!) {
      if (!gateKeys.has(`${producer}->${consumer}`)) {
        missing.push({ producer, consumer });
      }
    }
  }
  return missing;
}

// ─────────────────────────── real-registry walk ───────────────────────────

test('every workflow in the registry has a contract on every DAG edge (ports binding, or a legacy gate)', () => {
  // The SAME check the registry runs at load (`validateWorkflowContracts`): for a
  // ports workflow every edge must carry a declared input the upstream stage
  // really outputs; for a legacy one every edge needs a shared produces/consumes
  // key. Asserted here too so a contract hole fails the suite with every problem
  // listed, not just the first.
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
  assert.ok(workflows.length >= 22, `expected the 22 shipped workflows, found ${workflows.length}`);
});

// ─────────────────────────── synthetic trivial-minimum-bar test ───────────────────────────

test('a bare { ok: true } stub gate satisfies coverage (trivial minimum bar)', () => {
  const dag = buildDag([{ job: 'producer' }, { job: 'consumer', dependsOn: ['producer'] }]);
  const produces = new Map([['producer', ['x']], ['consumer', []]]);
  const consumes = new Map([['producer', []], ['consumer', ['x']]]);

  const missing = missingGateEdges(dag, produces, consumes);
  assert.deepEqual(missing, []);
});

// ─────────────────────────── synthetic negative-case test ───────────────────────────

test('a missing gate is genuinely detected (regression guard for the checker itself)', () => {
  const dag = buildDag([{ job: 'producer' }, { job: 'consumer', dependsOn: ['producer'] }]);
  const produces = new Map([['producer', []], ['consumer', []]]);
  const consumes = new Map([['producer', []], ['consumer', []]]);

  const missing = missingGateEdges(dag, produces, consumes);
  assert.deepEqual(missing, [{ producer: 'producer', consumer: 'consumer' }]);
});

console.log(`\n${passed} gate-coverage test(s) passed`);
