// Typed-artifact contracts for the stock-digest workflow's stage boundaries:
//   stock-portfolio-fetch    ──stock-raw-portfolio───────▶ stock-portfolio-snapshot
//   stock-portfolio-snapshot ──stock-digest-portfolio──▶ stock-sector-lookup
//   stock-portfolio-snapshot ──stock-digest-portfolio──▶ stock-digest-build (fan-in)
//   stock-sector-lookup      ──stock-sectors───────────▶ stock-digest-build
//
// Unlike the places/perfumes contracts, the sectors boundary is DELIBERATELY
// OPTIONAL: FINNHUB_API_KEY may be unset, in which case stock-sector-lookup
// soft-skips and data/out/sectors.json may never be written (or may be written
// as `{}`). Neither case is a violation — only actual corruption (unparseable
// JSON) or a genuine shape drift (top-level array instead of object, or a
// non-string/non-null value) fails the gate.
import { existsSync, readFileSync } from 'node:fs';
import type { ArtifactContract, ExpectationResult, GateResult } from '../../core/types.js';
import { portfolioJsonPath, rawPortfolioJsonPath, sectorsJsonPath } from './config.js';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
 * stock-portfolio-snapshot → stock-sector-lookup / stock-digest-build boundary:
 * stock-digest's OWN portfolio.json (independent of stocks-sync's — see the
 * workflow-level decoupling note). Must parse and be a plain JSON array of
 * NormalizedPosition records — every entry, if any, has a string `ticker` and
 * an `account` of `invest`/`isa`. A ZERO-length array is legitimate (every
 * position sold, or Trading212 credentials briefly returned nothing) and passes.
 */
export function stockDigestPortfolioContract(file: string = portfolioJsonPath): ArtifactContract {
  return {
    key: 'stock-digest-portfolio',
    description:
      'stock-portfolio-snapshot output: portfolio.json — a JSON array of stock-digest\'s own ' +
      'normalized Trading212 positions, independent of stocks-sync.',
    shape: {
      summary: 'The current open equity positions, fetched independently by stock-digest itself.',
      format: 'JSON file (portfolio.json), a plain array — not wrapped in an object',
      expectations: [
        { label: PORTFOLIO_EXP.json, detail: 'The hand-off file exists and parses as JSON.' },
        { label: PORTFOLIO_EXP.array, detail: 'The top-level JSON value is an array (zero or more positions).' },
        { label: PORTFOLIO_EXP.entries, detail: 'Each position (if any) has a text ticker and account = "invest" or "isa".' },
      ],
    },
    check(): GateResult {
      const checks: ExpectationResult[] = [];
      if (!existsSync(file)) {
        checks.push({ label: PORTFOLIO_EXP.json, ok: false, actual: `file missing: ${file}` });
        return fromChecks(checks);
      }
      let obj: unknown;
      try {
        obj = JSON.parse(readFileSync(file, 'utf8'));
      } catch (e) {
        checks.push({ label: PORTFOLIO_EXP.json, ok: false, actual: `not valid JSON — ${errMsg(e)}` });
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

const RAW_PORTFOLIO_EXP = {
  json: 'A readable JSON file',
  array: 'A plain top-level array',
  entries: 'Every position has a ticker + a valid account',
};

/**
 * stock-portfolio-fetch → stock-portfolio-snapshot boundary: raw-portfolio.json.
 * Must parse and be a plain JSON array of (pre-resolution) NormalizedPosition
 * records — every entry, if any, has a string `ticker` and an `account` of
 * `invest`/`isa`. Identical required-field shape to `stockDigestPortfolioContract`
 * (a NormalizedPosition has the same required fields before AND after
 * ISIN/ticker resolution) — this is deliberately a SEPARATE factory/key, not
 * shared with `stockDigestPortfolioContract`, since it validates a DIFFERENT file.
 */
export function stockRawPortfolioContract(file: string = rawPortfolioJsonPath): ArtifactContract {
  return {
    key: 'stock-raw-portfolio',
    description:
      'stock-portfolio-fetch output: raw-portfolio.json — a JSON array of fetched, ' +
      'pre-resolution positions.',
    shape: {
      summary: 'The just-fetched, not-yet-ticker-resolved open equity positions from Trading212 (may legitimately be empty).',
      format: 'JSON file (raw-portfolio.json), a plain array — not wrapped in an object',
      expectations: [
        { label: RAW_PORTFOLIO_EXP.json, detail: 'The hand-off file exists and parses as JSON.' },
        { label: RAW_PORTFOLIO_EXP.array, detail: 'The top-level JSON value is an array (zero or more positions).' },
        { label: RAW_PORTFOLIO_EXP.entries, detail: 'Each position (if any) has a text ticker and account = "invest" or "isa".' },
      ],
    },
    check(): GateResult {
      const checks: ExpectationResult[] = [];
      if (!existsSync(file)) {
        checks.push({ label: RAW_PORTFOLIO_EXP.json, ok: false, actual: `file missing: ${file}` });
        return fromChecks(checks);
      }
      let obj: unknown;
      try {
        obj = JSON.parse(readFileSync(file, 'utf8'));
      } catch (e) {
        checks.push({ label: RAW_PORTFOLIO_EXP.json, ok: false, actual: `not valid JSON — ${errMsg(e)}` });
        return fromChecks(checks);
      }
      checks.push({ label: RAW_PORTFOLIO_EXP.json, ok: true, actual: 'valid JSON' });
      const isArr = Array.isArray(obj);
      checks.push({ label: RAW_PORTFOLIO_EXP.array, ok: isArr, actual: isArr ? 'array' : `${typeof obj}` });
      if (!isArr) return fromChecks(checks);
      const arr = obj as Record<string, unknown>[];
      if (arr.length === 0) {
        checks.push({ label: RAW_PORTFOLIO_EXP.entries, ok: true, actual: 'no positions to check' });
        return fromChecks(checks, '0 position(s)');
      }
      const bad = arr.find(
        (p) => !p || typeof p.ticker !== 'string' || (p.account !== 'invest' && p.account !== 'isa'),
      );
      checks.push({
        label: RAW_PORTFOLIO_EXP.entries,
        ok: !bad,
        actual: bad ? `bad entry: ${JSON.stringify(bad)}` : 'all entries well-formed',
      });
      const tickers = arr.slice(0, 3).map((p) => JSON.stringify(p.ticker)).join(', ');
      return fromChecks(checks, `${arr.length} position(s)${tickers ? ` · e.g. ${tickers}` : ''}`);
    },
  };
}

const SECTORS_EXP = {
  json: 'A readable JSON file, or absent (optional)',
  isObject: 'The top-level value, if present, is a JSON object (not an array)',
  valueTypes: 'Every value is a string or null',
};

/**
 * stock-sector-lookup → stock-digest-build boundary: sectors.json. A ticker ->
 * resolved-Finnhub-industry map. Missing file or an empty `{}` are BOTH
 * legitimate ("FINNHUB_API_KEY unset" / "nothing resolved yet") and pass. Only
 * unparseable JSON, a non-object top-level value, or a non-string/non-null
 * entry value are violations.
 */
export function stockSectorsContract(file: string = sectorsJsonPath): ArtifactContract {
  return {
    key: 'stock-sectors',
    description:
      'stock-sector-lookup output: sectors.json — ticker -> resolved Finnhub industry (or null). ' +
      'Optional: missing file or an empty object are both valid (FINNHUB_API_KEY may be unset).',
    shape: {
      summary: 'A ticker -> industry map used to build the digest\'s diversification section. Optional.',
      format: 'JSON file (sectors.json), object keyed by ticker',
      expectations: [
        { label: SECTORS_EXP.json, detail: 'The file either does not exist yet (sector lookup is optional) or parses as JSON.' },
        { label: SECTORS_EXP.isObject, detail: 'When present, the top-level value is a plain object, not an array.' },
        { label: SECTORS_EXP.valueTypes, detail: 'When non-empty, every value is either an industry name string or null.' },
      ],
    },
    check(): GateResult {
      const checks: ExpectationResult[] = [];

      if (!existsSync(file)) {
        checks.push({
          label: SECTORS_EXP.json,
          ok: true,
          actual: 'sectors.json not present — sector lookup is optional (FINNHUB_API_KEY unset or no tickers resolved yet)',
        });
        return fromChecks(checks, 'sectors.json absent (optional)');
      }

      let obj: unknown;
      try {
        obj = JSON.parse(readFileSync(file, 'utf8'));
      } catch (e) {
        checks.push({ label: SECTORS_EXP.json, ok: false, actual: `not valid JSON — ${errMsg(e)}` });
        return fromChecks(checks);
      }
      checks.push({ label: SECTORS_EXP.json, ok: true, actual: 'valid JSON' });

      const isObject = !!obj && typeof obj === 'object' && !Array.isArray(obj);
      checks.push({
        label: SECTORS_EXP.isObject,
        ok: isObject,
        actual: isObject ? 'object' : Array.isArray(obj) ? 'array (expected object)' : typeof obj,
      });
      if (!isObject) return fromChecks(checks);

      const map = obj as Record<string, unknown>;
      const entries = Object.entries(map);
      if (entries.length === 0) {
        checks.push({ label: SECTORS_EXP.valueTypes, ok: true, actual: 'empty object — no tickers resolved yet' });
        return fromChecks(checks, '0 ticker(s) (empty — optional)');
      }

      const bad = entries.find(([, v]) => v !== null && typeof v !== 'string');
      checks.push({
        label: SECTORS_EXP.valueTypes,
        ok: !bad,
        actual: bad
          ? `"${bad[0]}" has a non-string/non-null value (${typeof bad[1]})`
          : `all ${entries.length} value(s) are string or null`,
      });
      const sampleEntries = entries.slice(0, 3).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ');
      return fromChecks(checks, `${entries.length} ticker(s)${sampleEntries ? ` · e.g. ${sampleEntries}` : ''}`);
    },
  };
}
