// The data the stocks-sync stages hand to each other. Trading212 is read-only here.
//
//   stocks-fetch ──raw──▶ stocks-resolve-names ──named──▶ stocks-snapshot ──portfolio──▶ stocks-watch ──breaches──▶ stocks-notify
import { fileArtifact, fromChecks, inlineArtifact, jsonArtifact } from '../../engine/index.js';
import type { NormalizedPosition } from '../../services/trading212.service.js';
import type { BreachLine } from './stages/stocks-watch.js';

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

/** Open positions straight from Trading212, tagged by account. */
export const rawPositions = jsonArtifact<NormalizedPosition[]>({
  key: 'stocks-raw-positions',
  description: 'The open positions as fetched from Trading212, tagged by account, before any name is resolved.',
  shape: { summary: 'Raw open positions from Trading212.', ...POSITIONS_SHAPE },
  check: positionsCheck,
  summary: (v) => `${v.length} position(s)`,
  items: (v) => v.map(positionRow),
});

/** The same positions with a company name where Trading212 has one. */
export const namedPositions = jsonArtifact<NormalizedPosition[]>({
  key: 'stocks-named-positions',
  description: 'The positions with each company name filled in where Trading212 knows it. A missing name is allowed.',
  shape: { summary: 'Positions with company names.', ...POSITIONS_SHAPE },
  check: positionsCheck,
  summary: (v) => `${v.length} position(s), ${v.filter((p) => p.name).length} named`,
  items: (v) => v.map(positionRow),
});

/** The portfolio snapshot the watch stage and the owner read. */
export const portfolio = jsonArtifact<NormalizedPosition[]>({
  key: 'stocks-portfolio',
  description: 'The portfolio snapshot: every open position with its quantity, prices and value.',
  shape: { summary: 'The portfolio snapshot.', ...POSITIONS_SHAPE },
  check: positionsCheck,
  summary: (v) => `${v.length} position(s), total value ${v.reduce((sum, p) => sum + p.currentValue, 0).toFixed(2)}`,
  items: (v) => v.map(positionRow),
});

/** The same snapshot as a readable table. */
export const portfolioReport = fileArtifact({
  key: 'stocks-portfolio-report',
  description: 'The portfolio as a markdown table, one row per position with its gain since purchase.',
  format: 'markdown',
  check: (f) => fromChecks([{ label: 'the report has content', ok: f.bytes > 0, actual: `${f.bytes} bytes` }]),
});

/** Positions that crossed the gain threshold this run and have not been announced. Usually empty. */
export const freshBreaches = jsonArtifact<BreachLine[]>({
  key: 'stocks-fresh-breaches',
  description: 'The positions that newly crossed the gain threshold this run. Empty on a normal day.',
  shape: {
    summary: 'Positions newly above the gain threshold.',
    format: 'JSON array of breaches',
    expectations: [
      { label: 'A plain top-level array', detail: 'The file is a JSON array. Empty is the normal, healthy state.' },
      { label: 'Every breach has a ticker and a numeric gain', detail: 'Each entry carries a text ticker and a number for the gain.' },
    ],
  },
  check(v) {
    if (!Array.isArray(v)) return fromChecks([{ label: 'A plain top-level array', ok: false, actual: typeof v }]);
    const bad = v.find((b) => !b || typeof b.ticker !== 'string' || !b.ticker || typeof b.gain !== 'number' || !Number.isFinite(b.gain));
    return fromChecks([
      { label: 'A plain top-level array', ok: true, actual: 'array' },
      { label: 'Every breach has a ticker and a numeric gain', ok: !bad, actual: bad ? `bad entry: ${JSON.stringify(bad).slice(0, 200)}` : 'all entries well-formed' },
    ], `${v.length} fresh breach(es)`);
  },
  summary: (v) => `${v.length} fresh breach(es)`,
  items: (v) => v.map((b) => ({
    id: `${b.account}:${b.ticker}`,
    title: b.ticker,
    fields: [{ label: 'Account', value: b.account }, { label: 'Gain', value: `${b.gain.toFixed(1)}%` }],
  })),
});

/** What the notify stage did. */
export interface BreachDigest {
  notified: number;
  tickers: string[];
}

export const breachDigest = inlineArtifact<BreachDigest>({
  key: 'stocks-breach-digest',
  description: 'What this run announced: how many newly breaching positions were pushed, and which.',
  check: (v) => fromChecks([{ label: 'has a count', ok: typeof v?.notified === 'number', actual: `${v?.notified} notified` }]),
  summary: (v) => (v.notified ? `${v.notified} announced: ${v.tickers.join(', ')}` : 'nothing to announce'),
});
