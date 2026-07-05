// Typed-artifact contracts for the stocks-sync workflow stage boundaries.
//
// Each factory returns an ArtifactContract whose `check()` inspects the REAL
// artifact left on disk and reports SHAPE (+ non-empty where appropriate)
// drift — enough to catch a Trading212 response shape change or a broken
// hand-off without brittle full-schema validation. The factories take an
// optional path so they can be unit-tested against synthetic fixtures (the
// jobs use the default data paths from stocksSyncConfig).
//
// Keys are shared across the producing job's `produces` and the consuming
// job's `consumes` so the workflow executor derives a gate at each edge:
//   stocks-fetch ──stocks-raw-positions──▶ stocks-resolve-names ──stocks-named-positions──▶
//   stocks-snapshot ──stocks-portfolio──▶ stocks-watch ──stocks-fresh-breaches──▶ stocks-notify
import { existsSync, readFileSync } from 'node:fs';
import type { ArtifactContract, ExpectationResult, GateResult } from '../../core/types.js';
import { stocksSyncConfig } from './config.js';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function readJson(file: string): { obj?: unknown; violation?: string } {
  if (!existsSync(file)) return { violation: `file missing: ${file}` };
  try {
    return { obj: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (e) {
    return { violation: `not valid JSON — ${errMsg(e)}` };
  }
}

/**
 * Build a GateResult from per-expectation results: `ok` iff every expectation
 * passed, with `violations` derived from the failures so the executor's gate
 * enforcement (which reads `ok`/`violations`) is unchanged.
 */
function fromChecks(checks: ExpectationResult[], sample?: string): GateResult {
  const failed = checks.filter((c) => !c.ok);
  const ok = failed.length === 0;
  return {
    ok,
    violations: ok ? undefined : failed.map((c) => `${c.label}: ${c.actual ?? 'failed'}`),
    checks,
    sample,
    detail: sample,
  };
}

const RAW_POSITIONS_EXP = {
  json: 'A readable JSON file',
  array: 'A plain top-level array',
  entries: 'Every position has a ticker + a valid account',
};

/**
 * stocks-fetch → stocks-snapshot boundary: raw-positions.json. Must parse and
 * be a plain JSON array of (pre-resolution) NormalizedPosition records —
 * every entry, if any, has a string `ticker` and an `account` of
 * `invest`/`isa`. Identical required-field shape to `stocksPortfolioContract`
 * (a NormalizedPosition has the same required fields before AND after
 * ISIN/ticker resolution — `isin`/`resolvedTicker` are optional either way) —
 * this is deliberately a SEPARATE factory/key, not shared with
 * `stocksPortfolioContract`, since it validates a DIFFERENT file at a
 * DIFFERENT stage boundary. A ZERO-length array is legitimate (no open
 * positions) and passes.
 */
export function stocksRawPositionsContract(
  file: string = stocksSyncConfig.rawPositionsJsonPath,
): ArtifactContract {
  return {
    key: 'stocks-raw-positions',
    description: 'stocks-fetch output: raw-positions.json — a JSON array of fetched, pre-resolution positions.',
    shape: {
      summary: 'The just-fetched, not-yet-ticker-resolved open equity positions from Trading212 (may legitimately be empty).',
      format: 'JSON file (raw-positions.json), a plain array — not wrapped in an object',
      expectations: [
        { label: RAW_POSITIONS_EXP.json, detail: 'The hand-off file exists and parses as JSON.' },
        { label: RAW_POSITIONS_EXP.array, detail: 'The top-level JSON value is an array (zero or more positions).' },
        { label: RAW_POSITIONS_EXP.entries, detail: 'Each position (if any) has a text ticker and account = "invest" or "isa".' },
      ],
    },
    check(): GateResult {
      const checks: ExpectationResult[] = [];
      const { obj, violation } = readJson(file);
      if (violation) {
        checks.push({ label: RAW_POSITIONS_EXP.json, ok: false, actual: violation });
        return fromChecks(checks);
      }
      checks.push({ label: RAW_POSITIONS_EXP.json, ok: true, actual: 'valid JSON' });
      const isArr = Array.isArray(obj);
      checks.push({ label: RAW_POSITIONS_EXP.array, ok: isArr, actual: isArr ? 'array' : `${typeof obj}` });
      if (!isArr) return fromChecks(checks);
      const arr = obj as Record<string, unknown>[];
      if (arr.length === 0) {
        checks.push({ label: RAW_POSITIONS_EXP.entries, ok: true, actual: 'no positions to check' });
        return fromChecks(checks, '0 position(s)');
      }
      const bad = arr.find(
        (p) => !p || typeof p.ticker !== 'string' || (p.account !== 'invest' && p.account !== 'isa'),
      );
      checks.push({
        label: RAW_POSITIONS_EXP.entries,
        ok: !bad,
        actual: bad ? `bad entry: ${JSON.stringify(bad)}` : 'all entries well-formed',
      });
      const tickers = arr.slice(0, 3).map((p) => JSON.stringify(p.ticker)).join(', ');
      return fromChecks(checks, `${arr.length} position(s)${tickers ? ` · e.g. ${tickers}` : ''}`);
    },
  };
}

const NAMED_POSITIONS_EXP = {
  json: 'A readable JSON file',
  array: 'A plain top-level array',
  entries: 'Every position has a ticker + a valid account',
};

/**
 * stocks-resolve-names → stocks-snapshot boundary: named-positions.json. Must
 * parse and be a plain JSON array of NormalizedPosition records — every entry,
 * if any, has a string `ticker` and an `account` of `invest`/`isa`. A resolved
 * `name` is best-effort (a resolution miss is a soft per-position skip, not a
 * gate violation) so `name` is NOT required here. A ZERO-length array is
 * legitimate (no open positions) and passes.
 */
export function stocksNamedPositionsContract(
  file: string = stocksSyncConfig.namedPositionsJsonPath,
): ArtifactContract {
  return {
    key: 'stocks-named-positions',
    description: 'stocks-resolve-names output: named-positions.json — a JSON array of positions with a resolved company name where available.',
    shape: {
      summary: 'The fetched positions with a Trading212-metadata company name attached where resolvable (may legitimately be empty).',
      format: 'JSON file (named-positions.json), a plain array — not wrapped in an object',
      expectations: [
        { label: NAMED_POSITIONS_EXP.json, detail: 'The hand-off file exists and parses as JSON.' },
        { label: NAMED_POSITIONS_EXP.array, detail: 'The top-level JSON value is an array (zero or more positions).' },
        { label: NAMED_POSITIONS_EXP.entries, detail: 'Each position (if any) has a text ticker and account = "invest" or "isa".' },
      ],
    },
    check(): GateResult {
      const checks: ExpectationResult[] = [];
      const { obj, violation } = readJson(file);
      if (violation) {
        checks.push({ label: NAMED_POSITIONS_EXP.json, ok: false, actual: violation });
        return fromChecks(checks);
      }
      checks.push({ label: NAMED_POSITIONS_EXP.json, ok: true, actual: 'valid JSON' });
      const isArr = Array.isArray(obj);
      checks.push({ label: NAMED_POSITIONS_EXP.array, ok: isArr, actual: isArr ? 'array' : `${typeof obj}` });
      if (!isArr) return fromChecks(checks);
      const arr = obj as Record<string, unknown>[];
      if (arr.length === 0) {
        checks.push({ label: NAMED_POSITIONS_EXP.entries, ok: true, actual: 'no positions to check' });
        return fromChecks(checks, '0 position(s)');
      }
      const bad = arr.find(
        (p) => !p || typeof p.ticker !== 'string' || (p.account !== 'invest' && p.account !== 'isa'),
      );
      checks.push({
        label: NAMED_POSITIONS_EXP.entries,
        ok: !bad,
        actual: bad ? `bad entry: ${JSON.stringify(bad)}` : 'all entries well-formed',
      });
      const tickers = arr.slice(0, 3).map((p) => JSON.stringify(p.ticker)).join(', ');
      return fromChecks(checks, `${arr.length} position(s)${tickers ? ` · e.g. ${tickers}` : ''}`);
    },
  };
}

const PORTFOLIO_EXP = {
  json: 'A readable JSON file',
  array: 'A plain top-level array',
  entries: 'Every position has a ticker + a valid account',
};

/**
 * stocks-snapshot → stocks-watch boundary: portfolio.json. Must parse and be a
 * plain JSON array of NormalizedPosition records — every entry, if any, has a
 * string `ticker` and an `account` of `invest`/`isa`. A ZERO-length array is a
 * legitimate state (every position sold) and passes.
 */
export function stocksPortfolioContract(file: string = stocksSyncConfig.portfolioJsonPath): ArtifactContract {
  return {
    key: 'stocks-portfolio',
    description: 'stocks-snapshot output: portfolio.json — a JSON array of normalized positions.',
    shape: {
      summary: 'The current open equity positions read from Trading212 (may legitimately be empty).',
      format: 'JSON file (portfolio.json), a plain array — not wrapped in an object',
      expectations: [
        { label: PORTFOLIO_EXP.json, detail: 'The hand-off file exists and parses as JSON.' },
        { label: PORTFOLIO_EXP.array, detail: 'The top-level JSON value is an array (zero or more positions).' },
        { label: PORTFOLIO_EXP.entries, detail: 'Each position (if any) has a text ticker and account = "invest" or "isa".' },
      ],
    },
    check(): GateResult {
      const checks: ExpectationResult[] = [];
      const { obj, violation } = readJson(file);
      if (violation) {
        checks.push({ label: PORTFOLIO_EXP.json, ok: false, actual: violation });
        return fromChecks(checks);
      }
      checks.push({ label: PORTFOLIO_EXP.json, ok: true, actual: 'valid JSON' });
      const isArr = Array.isArray(obj);
      checks.push({ label: PORTFOLIO_EXP.array, ok: isArr, actual: isArr ? 'array' : `${typeof obj}` });
      if (!isArr) return fromChecks(checks);
      const arr = obj as Record<string, unknown>[];
      if (arr.length === 0) {
        checks.push({ label: PORTFOLIO_EXP.entries, ok: true, actual: 'no positions to check' });
        return fromChecks(checks, '0 position(s)');
      }
      const bad = arr.find(
        (p) => !p || typeof p.ticker !== 'string' || (p.account !== 'invest' && p.account !== 'isa'),
      );
      checks.push({
        label: PORTFOLIO_EXP.entries,
        ok: !bad,
        actual: bad ? `bad entry: ${JSON.stringify(bad)}` : 'all entries well-formed',
      });
      const tickers = arr.slice(0, 3).map((p) => JSON.stringify(p.ticker)).join(', ');
      return fromChecks(checks, `${arr.length} position(s)${tickers ? ` · e.g. ${tickers}` : ''}`);
    },
  };
}

const BREACHES_EXP = {
  json: 'A readable JSON file',
  array: 'A plain top-level array',
  entries: 'Every breach has a ticker + a numeric gain',
};

/**
 * stocks-watch → stocks-notify boundary: fresh-breaches.json. Must parse and
 * be a plain JSON array of BreachLine records — every entry, if any, has a
 * string `ticker` and a numeric `gain`. An EMPTY array is the normal, healthy,
 * expected state on most runs (no fresh breaches) and passes.
 */
export function stocksFreshBreachesContract(
  file: string = stocksSyncConfig.freshBreachesJsonPath,
): ArtifactContract {
  return {
    key: 'stocks-fresh-breaches',
    description: 'stocks-watch output: fresh-breaches.json — a JSON array of this run\'s fresh 30%+ breaches.',
    shape: {
      summary: 'Positions that freshly breached 30%+ above their average buy price this run (often empty).',
      format: 'JSON file (fresh-breaches.json), a plain array — not wrapped in an object',
      expectations: [
        { label: BREACHES_EXP.json, detail: 'The hand-off file exists and parses as JSON.' },
        { label: BREACHES_EXP.array, detail: 'The top-level JSON value is an array (zero or more breaches — zero is normal).' },
        { label: BREACHES_EXP.entries, detail: 'Each breach (if any) has a text ticker and a numeric gain.' },
      ],
    },
    check(): GateResult {
      const checks: ExpectationResult[] = [];
      const { obj, violation } = readJson(file);
      if (violation) {
        checks.push({ label: BREACHES_EXP.json, ok: false, actual: violation });
        return fromChecks(checks);
      }
      checks.push({ label: BREACHES_EXP.json, ok: true, actual: 'valid JSON' });
      const isArr = Array.isArray(obj);
      checks.push({ label: BREACHES_EXP.array, ok: isArr, actual: isArr ? 'array' : `${typeof obj}` });
      if (!isArr) return fromChecks(checks);
      const arr = obj as Record<string, unknown>[];
      if (arr.length === 0) {
        checks.push({ label: BREACHES_EXP.entries, ok: true, actual: 'no breaches to check' });
        return fromChecks(checks, '0 breach(es)');
      }
      const bad = arr.find((b) => !b || typeof b.ticker !== 'string' || typeof b.gain !== 'number');
      checks.push({
        label: BREACHES_EXP.entries,
        ok: !bad,
        actual: bad ? `bad entry: ${JSON.stringify(bad)}` : 'all entries well-formed',
      });
      const tickers = arr.slice(0, 3).map((b) => JSON.stringify(b.ticker)).join(', ');
      return fromChecks(checks, `${arr.length} breach(es)${tickers ? ` · e.g. ${tickers}` : ''}`);
    },
  };
}
