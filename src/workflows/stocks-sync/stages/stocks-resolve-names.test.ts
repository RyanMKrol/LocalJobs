// stocks-resolve-names tests — hermetic: no live Trading212 API calls, no
// filesystem writes to the real job data dir. Uses a stub raw-positions reader +
// stub writer + the scratch DB (npm test sets LOCALJOBS_DB).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it, beforeEach } from 'node:test';

import { getWorkItem, isWorkItemDone, toStoredPath } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import type { NormalizedPosition, Trading212Instrument } from '../../../services/trading212.service.js';
import { stocksSyncConfig } from '../config.js';
import { dayKey } from './stocks-snapshot.js';
import {
  runStocksResolveNames,
  type NamedPositionsWriter,
  type RawPositionsReader,
} from './stocks-resolve-names.js';

function fakeCtx(logs?: string[], levels?: Array<{ msg: string; level?: string }>): JobContext {
  return {
    log: (msg, level) => {
      logs?.push(msg);
      levels?.push({ msg, level });
    },
    progress() {},
    selectedRoots: () => null,
    rootAllowed: () => true,
  };
}

function makeNormalized(overrides: Partial<NormalizedPosition> = {}): NormalizedPosition {
  return {
    ticker: 'AAPL_US_EQ',
    account: 'invest',
    quantity: 10,
    averageBuyPrice: 100,
    currentPrice: 130,
    currentValue: 1300,
    ...overrides,
  };
}

function stubRaw(positions: NormalizedPosition[]): RawPositionsReader {
  return () => positions;
}

function makeWriterSpy() {
  const calls: NormalizedPosition[][] = [];
  const write: NamedPositionsWriter = (positions) => {
    calls.push(positions);
  };
  return { write, calls };
}

function makeInstrument(overrides: Partial<Trading212Instrument> = {}): Trading212Instrument {
  return {
    ticker: 'AAPL_US_EQ',
    name: 'Apple Inc.',
    isin: 'US0378331005',
    currencyCode: 'USD',
    type: 'STOCK',
    ...overrides,
  };
}

const JOB = 'stocks-resolve-names';

describe('runStocksResolveNames', () => {
  beforeEach(() => {
    process.env.TRADING212_API_KEY_ID = 'test-key-id';
    process.env.TRADING212_API_SECRET_KEY = 'test-secret-key';
  });

  it('does not import or call any OpenFIGI-related function', () => {
    const source = readFileSync(new URL('./stocks-resolve-names.ts', import.meta.url), 'utf8')
      // strip comments — this file's prose legitimately explains it does NOT touch ISIN/OpenFIGI
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/\.isin\b|isin\s*[:=]|import\s*\{[^}]*\bisin\b/i.test(source), 'must not reference an isin field/import');
    assert.ok(!/resolveTickers/.test(source), 'must not reference resolveTickers');
    assert.ok(!/resolveOpenFigiTickersBatched/.test(source), 'must not reference resolveOpenFigiTickersBatched');
  });

  it('records zero ledger rows when there are no raw positions to resolve', async () => {
    const { write, calls } = makeWriterSpy();
    const now = new Date('2026-07-13T00:00:00.000Z');

    await runStocksResolveNames(fakeCtx(), {
      readRawPositions: stubRaw([]),
      writeNamedPositions: write,
      now,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 0);
    assert.ok(!isWorkItemDone(JOB, dayKey(now), 1), 'no ledger row when there is nothing to resolve');
  });

  it('resolves a company name from Trading212 metadata and attaches it', async () => {
    const pos = makeNormalized({ ticker: 'AAPL_US_EQ' });
    const { write, calls } = makeWriterSpy();
    let metadataCalls = 0;
    const now = new Date('2026-07-13T09:00:00.000Z');

    await runStocksResolveNames(fakeCtx(), {
      readRawPositions: stubRaw([pos]),
      fetchInstrumentsMetadata: async () => {
        metadataCalls++;
        return [makeInstrument()];
      },
      writeNamedPositions: write,
      now,
    });

    assert.equal(metadataCalls, 1, 'instruments-metadata is fetched at most once per stage run');
    assert.equal(calls[0][0].name, 'Apple Inc.');

    const row = getWorkItem(JOB, dayKey(now));
    assert.ok(row, 'ledger row should exist');
    const detail = JSON.parse(row!.detail!);
    assert.equal(detail.resolvedCount, 1);
    assert.equal(detail.totalPositions, 1);
    assert.equal(detail.name, `Names resolved — ${dayKey(now)}`);
    assert.equal(detail.format, 'json');
    assert.equal(detail.path, toStoredPath(stocksSyncConfig.namedPositionsJsonPath), 'stored relative to WORKFLOWS_ROOT (T447)');
  });

  it('leaves name undefined and logs a warn when the ticker is absent from instruments-metadata', async () => {
    const pos = makeNormalized({ ticker: 'UNKNOWN_TICKER_EQ' });
    const { write, calls } = makeWriterSpy();
    const logs: string[] = [];
    const levels: Array<{ msg: string; level?: string }> = [];
    const now = new Date('2026-07-13T10:00:00.000Z');

    await runStocksResolveNames(fakeCtx(logs, levels), {
      readRawPositions: stubRaw([pos]),
      fetchInstrumentsMetadata: async () => [makeInstrument({ ticker: 'OTHER_TICKER_EQ' })],
      writeNamedPositions: write,
      now,
    });

    assert.equal(calls[0][0].name, undefined);
    assert.ok(
      levels.some((l) => l.level === 'warn' && l.msg.includes('UNKNOWN_TICKER_EQ')),
      'should log at warn level naming the unresolved ticker',
    );

    const row = getWorkItem(JOB, dayKey(now));
    const detail = JSON.parse(row!.detail!);
    assert.equal(detail.resolvedCount, 0);
    assert.equal(detail.totalPositions, 1);
  });

  it('throws if TRADING212_API_KEY_ID is missing (and there is work to resolve)', async () => {
    const saved = process.env.TRADING212_API_KEY_ID;
    delete process.env.TRADING212_API_KEY_ID;
    try {
      await assert.rejects(
        () =>
          runStocksResolveNames(fakeCtx(), {
            readRawPositions: stubRaw([makeNormalized()]),
            fetchInstrumentsMetadata: async () => [],
            writeNamedPositions: () => {},
          }),
        /TRADING212_API_KEY_ID/,
      );
    } finally {
      if (saved !== undefined) process.env.TRADING212_API_KEY_ID = saved;
    }
  });

  it('throws if TRADING212_API_SECRET_KEY is missing (and there is work to resolve)', async () => {
    const saved = process.env.TRADING212_API_SECRET_KEY;
    delete process.env.TRADING212_API_SECRET_KEY;
    try {
      await assert.rejects(
        () =>
          runStocksResolveNames(fakeCtx(), {
            readRawPositions: stubRaw([makeNormalized()]),
            fetchInstrumentsMetadata: async () => [],
            writeNamedPositions: () => {},
          }),
        /TRADING212_API_SECRET_KEY/,
      );
    } finally {
      if (saved !== undefined) process.env.TRADING212_API_SECRET_KEY = saved;
    }
  });
});
