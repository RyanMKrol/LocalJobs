import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

import { callService } from '../../../core/services.js';
import type { JobContext } from '../../../core/types.js';
import { markWorkItem } from '../../../db/store.js';
import {
  fetchInstrumentsMetadata,
  type InstrumentsMetadataFetcher,
  type NormalizedPosition,
} from '../../../services/trading212.service.js';
import { stocksSyncConfig } from '../config.js';
import { dayKey } from './stocks-snapshot.js';

const JOB_NAME = 'stocks-resolve-names';

// ---------------------------------------------------------------------------
// Raw-positions reader (the hand-off from stocks-fetch) — a short-lived
// duplicate of stocks-snapshot.ts's own reader; T414 will consolidate this.
// ---------------------------------------------------------------------------

export type RawPositionsReader = () => NormalizedPosition[];

export function readRawPositions(): NormalizedPosition[] {
  if (!existsSync(stocksSyncConfig.rawPositionsJsonPath)) return [];
  return JSON.parse(readFileSync(stocksSyncConfig.rawPositionsJsonPath, 'utf8')) as NormalizedPosition[];
}

export type NamedPositionsWriter = (positions: NormalizedPosition[]) => void;

export function writeNamedPositions(positions: NormalizedPosition[]): void {
  mkdirSync(stocksSyncConfig.outDir, { recursive: true });
  writeFileSync(stocksSyncConfig.namedPositionsJsonPath, JSON.stringify(positions, null, 2));
}

/**
 * Stage 2: resolve each fetched position's company name from Trading212's own
 * instruments-metadata endpoint — no OpenFIGI, no ISIN, just a broker-agnostic
 * `name` field to make the eventual report readable. Writes
 * data/out/named-positions.json for `stocks-snapshot` to read.
 */
export async function runStocksResolveNames(
  ctx: JobContext,
  opts: {
    readRawPositions?: RawPositionsReader;
    fetchInstrumentsMetadata?: InstrumentsMetadataFetcher;
    writeNamedPositions?: NamedPositionsWriter;
    now?: Date;
  } = {},
): Promise<void> {
  const readRawPositionsFn = opts.readRawPositions ?? readRawPositions;
  const writeNamedPositionsFn = opts.writeNamedPositions ?? writeNamedPositions;
  const now = opts.now ?? new Date();

  ctx.log('info: stocks-resolve-names starting — resolving company names from Trading212 metadata');

  const positions = readRawPositionsFn();
  ctx.log(`info: read ${positions.length} raw position(s) from stocks-fetch`);

  if (positions.length === 0) {
    writeNamedPositionsFn(positions);
    ctx.log('info: no open positions to resolve — done');
    ctx.progress(100, 'no positions to resolve');
    return;
  }

  const apiKeyId = process.env.TRADING212_API_KEY_ID ?? '';
  const apiSecretKey = process.env.TRADING212_API_SECRET_KEY ?? '';
  if (!apiKeyId) throw new Error('TRADING212_API_KEY_ID is not set');
  if (!apiSecretKey) throw new Error('TRADING212_API_SECRET_KEY is not set');

  const fetchInstrumentsMetadataFn =
    opts.fetchInstrumentsMetadata ??
    ((keyId, secret) => callService('trading212-instruments', () => fetchInstrumentsMetadata(keyId, secret)));

  const instruments = await fetchInstrumentsMetadataFn(apiKeyId, apiSecretKey);
  ctx.log(`info: fetched ${instruments.length} instrument(s) from Trading212 instruments-metadata`);
  const nameByTicker = new Map(instruments.map((i) => [i.ticker, i.name]));

  const namedPositions = positions.map((p) => {
    const name = nameByTicker.get(p.ticker);
    if (!name) {
      ctx.log(`warn: could not resolve company name for Trading212 ticker ${p.ticker}`);
      return p;
    }
    return { ...p, name };
  });

  const resolvedCount = namedPositions.filter((p) => p.name).length;
  ctx.log(`info: resolved a company name for ${resolvedCount}/${namedPositions.length} position(s)`);

  writeNamedPositionsFn(namedPositions);
  ctx.log(`info: wrote ${namedPositions.length} named position(s) to data/out/named-positions.json`);

  const key = dayKey(now);
  markWorkItem(JOB_NAME, key, 'success', {
    detail: {
      name: `Names resolved — ${key}`,
      resolvedCount,
      totalPositions: namedPositions.length,
      path: stocksSyncConfig.namedPositionsJsonPath,
      format: 'json',
    },
  });

  ctx.log(
    `info: stocks-resolve-names complete — recorded 1 ledger row (${key}) for ${namedPositions.length} ` +
      `position(s), ${resolvedCount} name(s) resolved`,
  );
  ctx.progress(100, `${namedPositions.length} position(s) recorded for ${key}`);
}
