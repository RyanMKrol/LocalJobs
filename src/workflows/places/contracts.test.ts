// The places artifact checks, and that the four stages bind as the manifest says.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindWorkflowPorts, validateWorkflowContracts } from '../../engine/ports.js';
import type { JobDefinition } from '../../engine/index.js';
import { enrichedPlaces, normalizedPlaces, resolvedPlaces } from './contracts.js';
import workflow from './places.workflow.js';
import ingest from './stages/ingest.job.js';
import resolve from './stages/resolve.job.js';
import enrich from './stages/enrich.job.js';
import llm from './stages/llm-enrich.job.js';
import type { EnrichedFile, IngestOutput, ResolvedFile } from './types.js';

const places = (list: unknown[], source: unknown = 'google-takeout') => ({ generatedAt: 'now', source, places: list }) as unknown as IngestOutput;

test('normalized places: Takeout-sourced, non-empty, every place named', () => {
  const ok = normalizedPlaces.check(places([{ name: 'Acme Fire Cult', cid: '123' }]));
  assert.equal(ok.ok, true, ok.violations?.join('; '));
  assert.ok(ok.sample?.includes('Acme Fire Cult'), 'the sample shows real data');
  assert.equal(normalizedPlaces.check(places([])).ok, false, 'zero places is how a broken Takeout layout shows up');
  assert.equal(normalizedPlaces.check(places([{ name: 'X' }], 'something-else')).ok, false);
  assert.equal(normalizedPlaces.check(places([{ cid: '1' }])).ok, false, 'a place with no name');
  const failed = normalizedPlaces.check(places([{ name: 'X' }], 'something-else'));
  assert.ok(failed.checks!.find((c) => /Takeout/.test(c.label) && !c.ok)?.actual?.includes('something-else'), 'the failed expectation says what it found');
});

test('resolved places: needs the map, an entry, and at least one real place_id', () => {
  const file = (resolved: Record<string, unknown>) => ({ generatedAt: 'now', resolved }) as unknown as ResolvedFile;
  assert.equal(resolvedPlaces.check(file({ '1': { cid: '1', name: 'A', status: 'resolved', placeId: 'ChIJ1' } })).ok, true);
  assert.equal(resolvedPlaces.check(file({})).ok, false);
  assert.equal(resolvedPlaces.check(file({ '1': { cid: '1', name: 'A', status: 'failed', placeId: null } })).ok, false);
  assert.equal(resolvedPlaces.check({} as ResolvedFile).ok, false);
});

test('enriched places: needs the map, an entry, and at least one place_id', () => {
  const file = (enriched: Record<string, unknown>) => ({ generatedAt: 'now', enriched }) as unknown as EnrichedFile;
  assert.equal(enrichedPlaces.check(file({ ChIJ1: { cid: '1', placeId: 'ChIJ1', status: 'success' } })).ok, true);
  assert.equal(enrichedPlaces.check(file({})).ok, false);
  assert.equal(enrichedPlaces.check({} as EnrichedFile).ok, false);
});

test('the last stage takes the Places details from enrich and the normalized places from ingest', () => {
  const jobs = new Map<string, JobDefinition>([ingest, resolve, enrich, llm].map((j) => [j.name, j]));
  const getJob = (name: string) => jobs.get(name);
  assert.deepEqual(validateWorkflowContracts(workflow, getJob), []);
  assert.deepEqual(
    bindWorkflowPorts(workflow, getJob).bindings.map((b) => `${b.producer} -> ${b.consumer}.${b.port}`).sort(),
    [
      'cid-to-place-id-resolver -> places-enrich.resolved',
      'places-enrich -> enrich-with-llm.enriched',
      'places-ingest -> cid-to-place-id-resolver.places',
      'places-ingest -> enrich-with-llm.places',
    ],
  );
  assert.equal(llm.product, true);
});
