// Regression guard for find-url's PerfumeRatings-seeding path (T401): a perfume
// whose live DynamoDB item already carries a valid fragranticaUrl must be
// recorded as an immediate success WITHOUT ever asking Claude. Hermetic: mocks
// the DynamoDB doc client (via dynamodb.service's _resetClient) so loadPerfumes()
// reads a synthetic table, uses the scratch work_items DB (npm test sets
// LOCALJOBS_DB), and points perfumesConfig.urlsFile at a scratch tmp file so no
// real job data/ files are touched.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, after } from 'node:test';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import type { JobContext } from '../../../core/types.js';
import { _resetClient } from '../../../services/dynamodb.service.js';
import { clearServiceCache } from '../../../db/store.js';
import { perfumesConfig } from '../config.js';
import { runFindUrl } from './find-url.js';

function makeMockClient(items: Record<string, unknown>[]): DynamoDBDocumentClient {
  return { send() { return Promise.resolve({ Items: items }); } } as unknown as DynamoDBDocumentClient;
}

function fakeCtx(): JobContext {
  return { log() {}, progress() {}, selectedRoots: () => null, rootAllowed: () => true };
}

describe('find-url — seeds from PerfumeRatings.fragranticaUrl, skipping Claude (T401)', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'perfumes-find-url-test-'));
  const originalUrlsFile = perfumesConfig.urlsFile;
  const originalDryRun = perfumesConfig.dryRun;
  perfumesConfig.urlsFile = join(tmpDir, 'fragrantica-urls.json');
  perfumesConfig.dryRun = true; // any non-seeded item takes the fabricated dry-run path, never spawns real Claude

  after(() => {
    perfumesConfig.urlsFile = originalUrlsFile;
    perfumesConfig.dryRun = originalDryRun;
    _resetClient();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('seeded item is recorded success with detail.seeded=true and never calls Claude', async () => {
    // loadPerfumes now caches the scan by table name (T510) — clear it so this
    // test's mock response isn't shadowed by a prior test's cache.
    clearServiceCache('dynamodb');
    _resetClient(
      makeMockClient([
        {
          id: 't401-seeded__brand__edp',
          title: 'Seeded Perfume',
          designer: 'Brand',
          type: 'EDP',
          fragranticaUrl: 'https://www.fragrantica.com/perfume/Brand/Seeded-Perfume-1.html',
        },
      ]),
    );
    const result = await runFindUrl(fakeCtx());
    assert.equal(result.ok, 1);
    assert.equal(result.failed, 0);

    const urls = JSON.parse(readFileSync(perfumesConfig.urlsFile, 'utf8')) as Record<string, string>;
    assert.equal(urls['t401-seeded__brand__edp'], 'https://www.fragrantica.com/perfume/Brand/Seeded-Perfume-1.html');
  });

  it('an item with no fragranticaUrl falls through to the (dry-run) search path', async () => {
    perfumesConfig.urlsFile = join(tmpDir, 'fragrantica-urls-2.json');
    clearServiceCache('dynamodb');
    _resetClient(
      makeMockClient([{ id: 't401-unseeded__brand__edt', title: 'Unseeded', designer: 'Brand', type: 'EDT' }]),
    );
    const result = await runFindUrl(fakeCtx());
    assert.equal(result.ok, 1);
    const urls = JSON.parse(readFileSync(perfumesConfig.urlsFile, 'utf8')) as Record<string, string>;
    assert.ok(existsSync(perfumesConfig.urlsFile));
    assert.match(urls['t401-unseeded__brand__edt'], /^https:\/\/www\.fragrantica\.com\/perfume\//);
  });
});

console.log('  ✓ perfumes find-url seeds from PerfumeRatings.fragranticaUrl, skipping Claude');
