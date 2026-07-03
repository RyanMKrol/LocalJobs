// Typed-artifact contract for the projects-sync workflow's sole stage boundary.
//
// Mirrors src/jobs/places/contracts.ts's normalizedPlacesContract: a single JSON
// array hand-off with a non-empty requirement (an empty catalog genuinely means
// project-summarize has nothing to do, same as places' empty-places case).
import { existsSync, readFileSync } from 'node:fs';
import type { ArtifactContract, ExpectationResult, GateResult } from '../../core/types.js';
import { projectsSyncConfig } from './config.js';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function readJson(file: string): { obj?: unknown; violation?: string } {
  if (!existsSync(file)) return { violation: `file missing: ${file}` };
  try {
    return { obj: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (e) {
    return { violation: `not valid JSON — ${errMsg(e)}` };
  }
}

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

const CATALOG_EXP = {
  json: 'A readable JSON file',
  array: 'Top-level value is an array',
  nonEmpty: 'Contains at least one repo',
  ids: 'Every entry has a repoId and name',
};

/**
 * github-sync → project-summarize boundary: projects.json. Must parse as a
 * non-empty JSON array of catalog entries, each with a non-empty repoId and
 * name (the two fields project-summarize keys its work off).
 */
export function projectsCatalogContract(
  file: string = projectsSyncConfig.catalogPath,
): ArtifactContract {
  return {
    key: 'projects-catalog',
    description:
      'github-sync output: projects.json — non-empty array of catalog entries with repoId + name.',
    shape: {
      summary: 'The filtered catalog of your GitHub repos to summarize.',
      format: 'JSON file (projects.json)',
      expectations: [
        { label: CATALOG_EXP.json, detail: 'The hand-off file exists and parses as JSON.' },
        { label: CATALOG_EXP.array, detail: 'The file is a JSON array of catalog entries.' },
        { label: CATALOG_EXP.nonEmpty, detail: 'A non-empty array — otherwise there is nothing to summarize.' },
        { label: CATALOG_EXP.ids, detail: 'Each entry carries a text repoId and name.' },
      ],
    },
    check(): GateResult {
      const checks: ExpectationResult[] = [];
      const { obj, violation } = readJson(file);
      if (violation) {
        checks.push({ label: CATALOG_EXP.json, ok: false, actual: violation });
        return fromChecks(checks);
      }
      checks.push({ label: CATALOG_EXP.json, ok: true, actual: 'valid JSON' });

      const isArr = Array.isArray(obj);
      checks.push({
        label: CATALOG_EXP.array,
        ok: isArr,
        actual: isArr ? 'top-level value is an array' : `top-level value is ${typeof obj}`,
      });
      if (!isArr) return fromChecks(checks);

      const arr = obj as Record<string, unknown>[];
      const nonEmpty = arr.length > 0;
      checks.push({
        label: CATALOG_EXP.nonEmpty,
        ok: nonEmpty,
        actual: `${arr.length} entr${arr.length === 1 ? 'y' : 'ies'}`,
      });
      if (!nonEmpty) return fromChecks(checks);

      const bad = arr.find(
        (e) => !e || typeof e.repoId !== 'string' || !e.repoId || typeof e.name !== 'string' || !e.name,
      );
      checks.push({
        label: CATALOG_EXP.ids,
        ok: !bad,
        actual: bad ? 'an entry is missing a repoId or name' : 'all entries have repoId + name',
      });

      const names = arr.slice(0, 3).map((e) => JSON.stringify(e?.name)).join(', ');
      const sample = `${arr.length} repo(s)${names ? ` · e.g. ${names}` : ''}`;
      return fromChecks(checks, sample);
    },
  };
}
