// Typed-artifact contract for the stock-digest workflow's single stage boundary:
// stock-sector-lookup ──stock-sectors──▶ stock-digest-build.
//
// Unlike the places/perfumes contracts, this boundary is DELIBERATELY OPTIONAL:
// FINNHUB_API_KEY may be unset, in which case stock-sector-lookup soft-skips and
// data/out/sectors.json may never be written (or may be written as `{}`). Neither
// case is a violation — only actual corruption (unparseable JSON) or a genuine
// shape drift (top-level array instead of object, or a non-string/non-null value)
// fails the gate.
import { existsSync, readFileSync } from 'node:fs';
import type { ArtifactContract, ExpectationResult, GateResult } from '../../core/types.js';
import { sectorsJsonPath } from './config.js';

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
