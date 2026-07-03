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
