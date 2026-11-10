// The data the stock-digest stages hand to each other. Trading212 is read-only here.
//
//   stock-portfolio-fetch ──raw──▶ stock-portfolio-snapshot ──portfolio──▶ stock-sector-lookup ──sectors──▶ stock-digest-build
//                                            └──────────────────portfolio──────────────────────────────────▲
//
// The build stage takes TWO inputs from two different stages: the portfolio from
// the snapshot and the sector map from the lookup. It starts only when both have
// succeeded.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { dirArtifact, fromChecks, jsonArtifact } from '../../engine/index.js';
import type { NormalizedPosition } from '../../services/trading212.service.js';
import type { SectorMap } from './stages/stock-sector-lookup.js';

const ACCOUNTS = ['invest', 'isa'];

/** A list of positions: an array whose entries each have a ticker and a known account. Empty is fine (everything sold). */
function positionsCheck(v: NormalizedPosition[]) {
  if (!Array.isArray(v)) return fromChecks([{ label: 'A plain top-level array', ok: false, actual: typeof v }]);
  const bad = v.find((p) => !p || typeof p.ticker !== 'string' || !p.ticker || !ACCOUNTS.includes(p.account));
  return fromChecks([
    { label: 'A plain top-level array', ok: true, actual: 'array' },
    { label: 'Every position has a ticker and an account', ok: !bad, actual: bad ? `bad entry: ${JSON.stringify(bad).slice(0, 200)}` : v.length ? 'all entries well-formed' : 'no positions to check' },
  ], `${v.length} position(s)`);
}

const POSITIONS_SHAPE = {
  format: 'JSON array of positions',
  expectations: [
    { label: 'A plain top-level array', detail: 'The file is a JSON array (zero or more positions; empty means everything was sold).' },
    { label: 'Every position has a ticker and an account', detail: 'Each entry carries a text ticker and an account of "invest" or "isa".' },
  ],
};

const positionRow = (p: NormalizedPosition) => ({
  id: `${p.account}:${p.ticker}`,
  title: p.name ?? p.resolvedTicker ?? p.ticker,
  fields: [
    { label: 'Ticker', value: p.ticker },
    { label: 'Account', value: p.account },
    { label: 'Value', value: p.currentValue.toFixed(2) },
  ],
});

/** Open positions straight from Trading212. */
export const rawPortfolio = jsonArtifact<NormalizedPosition[]>({
  key: 'stock-raw-portfolio',
  description: 'The open positions as fetched from Trading212, before any ticker is resolved.',
  shape: { summary: 'Raw open positions from Trading212.', ...POSITIONS_SHAPE },
  check: positionsCheck,
  summary: (v) => `${v.length} position(s)`,
  items: (v) => v.map(positionRow),
});

/** The positions with a real-world ticker where one could be resolved. */
export const digestPortfolio = jsonArtifact<NormalizedPosition[]>({
  key: 'stock-digest-portfolio',
  description: 'The positions with each real-world ticker resolved where possible. This is what the digest is written from.',
  shape: { summary: 'Positions with resolved tickers.', ...POSITIONS_SHAPE },
  check: positionsCheck,
  summary: (v) => `${v.length} position(s), ${v.filter((p) => p.resolvedTicker).length} with a resolved ticker`,
  items: (v) => v.map(positionRow),
});

/**
 * Ticker to industry, built up over many runs: a ticker is looked up once. Empty
 * is valid (no FINNHUB_API_KEY, or nothing resolved yet): the digest then leaves
 * out its diversification section.
 */
export const sectors = jsonArtifact<SectorMap>({
  key: 'stock-sectors',
  description: 'Each held ticker mapped to its industry, or null where none could be found. Grows as tickers are looked up.',
  shape: {
    summary: 'Ticker to industry lookup.',
    format: 'JSON object { ticker: industry | null }',
    expectations: [
      { label: 'A JSON object', detail: 'The file is an object of ticker to industry (empty when nothing is resolved yet).' },
      { label: 'Every value is text or null', detail: 'Each industry is a string, or null for a ticker with no known industry.' },
    ],
  },
  check(v) {
    const isObj = v !== null && typeof v === 'object' && !Array.isArray(v);
    if (!isObj) return fromChecks([{ label: 'A JSON object', ok: false, actual: Array.isArray(v) ? 'array' : typeof v }]);
    const bad = Object.entries(v).find(([, industry]) => industry !== null && typeof industry !== 'string');
    return fromChecks([
      { label: 'A JSON object', ok: true, actual: 'object' },
      { label: 'Every value is text or null', ok: !bad, actual: bad ? `"${bad[0]}" maps to ${JSON.stringify(bad[1])}` : 'all values well-formed' },
    ], `${Object.keys(v).length} ticker(s)`);
  },
  summary: (v) => `${Object.keys(v).length} ticker(s), ${Object.values(v).filter(Boolean).length} with an industry`,
  items: (v) => Object.entries(v).map(([ticker, industry]) => ({ id: ticker, title: ticker, fields: [{ label: 'Industry', value: industry ?? 'unknown' }] })),
});

/** The weekly digests. One per ISO week; a week is rewritten in place. */
export const digests = dirArtifact({
  key: 'stock-digests',
  description: 'The weekly digests: stock-digest-<YYYY-Www>.md.',
  format: 'markdown',
  // The digests share data/out with the portfolio, the sector map and the facts files.
  files: (name) => /^stock-digest-(?!facts-).*\.md$/.test(name),
  check(d) {
    const empty = d.files.filter((f) => statSync(join(d.path, f)).size === 0);
    return fromChecks([{ label: 'no digest is empty', ok: empty.length === 0, actual: empty.length ? `empty: ${empty.join(', ')}` : `${d.files.length} digest(s)` }], `${d.files.length} digest(s)`);
  },
  count: (d) => d.files.length,
  summary: (d) => `${d.files.length} digest(s)`,
  items: (d) => [...d.files].reverse().map((f) => ({ id: f, title: f.replace(/^stock-digest-|\.md$/g, ''), preview: { path: join(d.path, f), format: 'markdown' } })),
});
