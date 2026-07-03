// Whole-repo invariant: every adjacent job pair (DAG edge) in every workflow must
// have a matching produces/consumes validation gate between them (see root
// CLAUDE.md's "Validation gates between workflow stages" section). This is the
// mechanical enforcement of that convention — a future workflow shipped without
// gates on some edge must fail `npm test`, not just leave a dashboard gap someone
// happens to notice. Complements dag.test.ts (pure DAG mechanics) and
// contracts.test.ts (individual real contracts) with the cross-cutting check.
import assert from 'node:assert/strict';
import { buildDag, deriveGates } from './dag.js';
import type { Dag } from './dag.js';
import { jobs, workflows } from '../jobs/registry.js';

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

test('every workflow in the registry has a validation gate on every DAG edge', () => {
  const jobsByName = new Map(jobs.map((j) => [j.name, j]));

  for (const workflow of workflows) {
    const dag = buildDag(workflow.jobs);

    const produces = new Map<string, string[]>();
    const consumes = new Map<string, string[]>();
    for (const name of dag.nodes) {
      const job = jobsByName.get(name);
      assert.ok(job, `workflow '${workflow.name}': member job '${name}' not found in registry`);
      produces.set(name, (job.produces ?? []).map((c) => c.key));
      consumes.set(name, (job.consumes ?? []).map((c) => c.key));
    }

    const missing = missingGateEdges(dag, produces, consumes);
    for (const { producer, consumer } of missing) {
      assert.fail(
        `workflow '${workflow.name}': edge ${producer} -> ${consumer} has NO matching produces/consumes ` +
          `key — add a validation gate (see src/jobs/CLAUDE.md)`,
      );
    }
  }
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
