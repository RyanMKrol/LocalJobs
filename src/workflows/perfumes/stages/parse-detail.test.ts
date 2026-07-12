// Regression guard for T407: the parse stage's success `detail` must describe
// what it produced (the written JSON's path/format + extracted counts), not just
// restate the item's identity. Hermetic: mocks the DynamoDB doc client so
// loadPerfumes() reads a synthetic table, runs in perfumesConfig.dryRun mode
// (never spawns real Claude), and points every config path at a scratch tmp dir
// so no real job data/ files are touched. Uses the scratch work_items DB
// (npm test sets LOCALJOBS_DB).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, after } from 'node:test';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import type { JobContext } from '../../../core/types.js';
import { clearServiceCache, getWorkItem } from '../../../db/store.js';
import { _resetClient } from '../../../services/dynamodb.service.js';
import { perfumesConfig } from '../config.js';
import { PARSE_JOB, runParse } from './parse.js';

function makeMockClient(items: Record<string, unknown>[]): DynamoDBDocumentClient {
  return { send() { return Promise.resolve({ Items: items }); } } as unknown as DynamoDBDocumentClient;
}

function fakeCtx(): JobContext {
  return { log() {}, progress() {}, selectedRoots: () => null, rootAllowed: () => true };
}

describe('parse — success detail describes what it produced (T407)', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'perfumes-parse-detail-test-'));
  const original = {
    pagesDir: perfumesConfig.pagesDir,
    pagesFailedDir: perfumesConfig.pagesFailedDir,
    fragranticaDir: perfumesConfig.fragranticaDir,
    dryRun: perfumesConfig.dryRun,
  };
  perfumesConfig.pagesDir = join(tmpDir, 'pages');
  perfumesConfig.pagesFailedDir = join(tmpDir, 'pages-failed');
  perfumesConfig.fragranticaDir = join(tmpDir, 'fragrantica');
  perfumesConfig.dryRun = true;
  mkdirSync(perfumesConfig.pagesDir, { recursive: true });
  mkdirSync(perfumesConfig.pagesFailedDir, { recursive: true });
  mkdirSync(perfumesConfig.fragranticaDir, { recursive: true });

  after(() => {
    perfumesConfig.pagesDir = original.pagesDir;
    perfumesConfig.pagesFailedDir = original.pagesFailedDir;
    perfumesConfig.fragranticaDir = original.fragranticaDir;
    perfumesConfig.dryRun = original.dryRun;
    _resetClient();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('records path/format/accordsCount/notesCount/rating in the ledger detail', async () => {
    const id = 't407-parse-detail__brand__edp';
    writeFileSync(join(perfumesConfig.pagesDir, `${id}.txt`), 'captured page text for the fixture perfume');
    // loadPerfumes now caches the scan by table name (T510) — clear it so this
    // test's mock response isn't shadowed by another test file's cache.
    clearServiceCache('dynamodb');
    _resetClient(
      makeMockClient([{ id, title: 'Fixture Perfume', designer: 'Brand', type: 'EDP' }]),
    );

    const result = await runParse(fakeCtx());
    assert.equal(result.ok, 1);
    assert.equal(result.failed, 0);

    const expectedPath = join(perfumesConfig.fragranticaDir, `${id}.json`);
    assert.ok(existsSync(expectedPath), 'parse must write the structured JSON artifact');

    const row = getWorkItem(PARSE_JOB, id);
    assert.ok(row, 'a work_items row must be recorded');
    const detail = JSON.parse(row!.detail!) as {
      name: string;
      format: string;
      path: string;
      accordsCount: number;
      notesCount: number;
      rating: number | null;
    };
    assert.equal(detail.format, 'json');
    assert.equal(detail.path, expectedPath);
    assert.equal(typeof detail.accordsCount, 'number');
    assert.equal(typeof detail.notesCount, 'number');
    assert.equal(detail.rating, null); // the dry-run fixture data carries no rating
  });
});

console.log('  ✓ perfumes parse records a descriptive success detail (path/format/counts)');
