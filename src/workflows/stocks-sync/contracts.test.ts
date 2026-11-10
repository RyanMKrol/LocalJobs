// The stocks-sync artifact checks, and that the five stages bind in a line.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindWorkflowPorts, validateWorkflowContracts } from '../../engine/ports.js';
import type { JobDefinition } from '../../engine/index.js';
import type { NormalizedPosition } from '../../services/trading212.service.js';
import { freshBreaches, namedPositions, portfolio, rawPositions } from './contracts.js';
import fetch from './stages/stocks-fetch.job.js';
import resolveNames from './stages/stocks-resolve-names.job.js';
import snapshot from './stages/stocks-snapshot.job.js';
import watch from './stages/stocks-watch.job.js';
import type { BreachLine } from './stages/stocks-watch.js';
import notify from './stages/stocks-notify.job.js';
import workflow from './stocks-sync.workflow.js';

const pos = (over: Partial<NormalizedPosition> = {}): NormalizedPosition => ({
  ticker: 'AAPL_US_EQ', quantity: 2, averageBuyPrice: 100, currentPrice: 150, currentValue: 300, account: 'invest', ...over,
});

for (const [name, artifact] of [['raw', rawPositions], ['named', namedPositions], ['portfolio', portfolio]] as const) {
  test(`${name}: a list of positions passes, and so does an empty one (everything sold)`, () => {
    const r = artifact.check([pos(), pos({ ticker: 'VUSA_EQ', account: 'isa' })]);
    assert.equal(r.ok, true, r.violations?.join('; '));
    assert.equal(artifact.check([]).ok, true);
  });

  test(`${name}: a non-array, a position with no ticker and an unknown account all fail`, () => {
    assert.equal(artifact.check({ positions: [] } as unknown as NormalizedPosition[]).ok, false);
    assert.equal(artifact.check([pos({ ticker: '' })]).ok, false);
    assert.equal(artifact.check([pos({ account: 'pension' as NormalizedPosition['account'] })]).ok, false);
  });
}

test('named: a position with no company name is allowed (a miss is a soft skip)', () => {
  assert.equal(namedPositions.check([pos({ name: undefined })]).ok, true);
  assert.equal(namedPositions.summary!([pos({ name: 'Apple Inc.' }), pos({ ticker: 'X_EQ' })]), '2 position(s), 1 named');
});

test('fresh breaches: empty is the normal state; a breach needs a ticker and a numeric gain', () => {
  const breach: BreachLine = { ticker: 'AAPL_US_EQ', account: 'invest', gain: 42.5, averageBuyPrice: 100, currentPrice: 142.5 };
  assert.equal(freshBreaches.check([]).ok, true);
  assert.equal(freshBreaches.check([breach]).ok, true);
  assert.equal(freshBreaches.check([{ ...breach, gain: 'lots' as unknown as number }]).ok, false);
  assert.equal(freshBreaches.check({} as unknown as BreachLine[]).ok, false);
});

test('the five stages bind in a line, each handed the previous one\'s output', () => {
  const jobs = new Map<string, JobDefinition>([fetch, resolveNames, snapshot, watch, notify].map((j) => [j.name, j]));
  const getJob = (name: string) => jobs.get(name);
  assert.deepEqual(validateWorkflowContracts(workflow, getJob), []);
  assert.deepEqual(
    bindWorkflowPorts(workflow, getJob).bindings.map((b) => `${b.producer} -> ${b.consumer}.${b.port}`),
    [
      'stocks-fetch -> stocks-resolve-names.raw',
      'stocks-resolve-names -> stocks-snapshot.named',
      'stocks-snapshot -> stocks-watch.portfolio',
      'stocks-watch -> stocks-notify.breaches',
    ],
  );
  assert.equal(snapshot.product, true, 'the portfolio snapshot is the workflow\'s product, not the notify stage');
});
