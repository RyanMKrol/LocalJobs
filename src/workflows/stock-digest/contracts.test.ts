// The stock-digest artifact checks, and the diamond the four stages form.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindWorkflowPorts, validateWorkflowContracts } from '../../engine/ports.js';
import type { JobDefinition } from '../../engine/index.js';
import type { NormalizedPosition } from '../../services/trading212.service.js';
import { digestPortfolio, digests, rawPortfolio, sectors } from './contracts.js';
import build from './stages/stock-digest-build.job.js';
import fetch from './stages/stock-portfolio-fetch.job.js';
import snapshot from './stages/stock-portfolio-snapshot.job.js';
import lookup from './stages/stock-sector-lookup.job.js';
import type { SectorMap } from './stages/stock-sector-lookup.js';
import workflow from './stock-digest.workflow.js';

const pos = (over: Partial<NormalizedPosition> = {}): NormalizedPosition => ({
  ticker: 'AAPL_US_EQ', quantity: 2, averageBuyPrice: 100, currentPrice: 150, currentValue: 300, account: 'invest', ...over,
});

for (const [name, artifact] of [['raw portfolio', rawPortfolio], ['portfolio', digestPortfolio]] as const) {
  test(`${name}: positions pass, an empty list passes, a non-array or a position with no ticker fails`, () => {
    assert.equal(artifact.check([pos()]).ok, true);
    assert.equal(artifact.check([]).ok, true, 'every position sold');
    assert.equal(artifact.check({} as unknown as NormalizedPosition[]).ok, false);
    assert.equal(artifact.check([pos({ ticker: '' })]).ok, false);
  });
}

test('sectors: an object of ticker to industry or null passes, empty included; anything else fails', () => {
  assert.equal(sectors.check({ AAPL_US_EQ: 'Technology', ODD_EQ: null }).ok, true);
  assert.equal(sectors.check({}).ok, true, 'nothing resolved yet, or no FINNHUB_API_KEY');
  assert.equal(sectors.check([] as unknown as SectorMap).ok, false);
  assert.equal(sectors.check({ AAPL_US_EQ: 7 } as unknown as SectorMap).ok, false);
  assert.equal(sectors.summary!({ A: 'Tech', B: null }), '2 ticker(s), 1 with an industry');
});

test('digests: only the weekly digest files are the artifact, not the facts files or the portfolio beside them', () => {
  const own = digests.files!;
  assert.equal(own('stock-digest-2026-W45.md'), true);
  assert.equal(own('stock-digest-facts-2026-W45.json'), false);
  assert.equal(own('portfolio.json'), false);
  assert.equal(own('sectors.json'), false);
});

test('the build stage takes the portfolio from the snapshot and the sector map from the lookup', () => {
  const jobs = new Map<string, JobDefinition>([fetch, snapshot, lookup, build].map((j) => [j.name, j]));
  const getJob = (name: string) => jobs.get(name);
  assert.deepEqual(validateWorkflowContracts(workflow, getJob), []);
  assert.deepEqual(
    bindWorkflowPorts(workflow, getJob).bindings.map((b) => `${b.producer} -> ${b.consumer}.${b.port}`).sort(),
    [
      'stock-portfolio-fetch -> stock-portfolio-snapshot.raw',
      'stock-portfolio-snapshot -> stock-digest-build.portfolio',
      'stock-portfolio-snapshot -> stock-sector-lookup.portfolio',
      'stock-sector-lookup -> stock-digest-build.sectors',
    ],
  );
});
