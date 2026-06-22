// Typed-artifact contracts for the perfumes workflow stage boundaries.
//
// Each factory returns an ArtifactContract whose `check()` inspects the REAL
// artifact left on disk and reports SHAPE + NON-EMPTY drift — enough to catch a
// Fragrantica format change or an empty/missing hand-off without brittle
// full-schema validation. The factories take an optional path so they can be
// unit-tested against synthetic fixtures (the jobs use the default data paths).
//
// Each contract ALSO declares a machine-readable `shape` (plain-English
// expectations for a non-expert reader) and its `check()` reports per-expectation
// pass/fail in `checks` plus a small `sample` of what actually flowed, so the
// dashboard gate page can show expected-vs-actual without anyone reading code.
//
// Keys are shared across the producing job's `produces` and the consuming job's
// `consumes` so the workflow executor derives a gate at each edge:
//   find-url ──fragrantica-urls──▶ fetch ──fragrantica-pages──▶ parse
//            ──fragrantica-data──▶ build
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ArtifactContract, ExpectationResult, GateResult } from '../../core/types.js';
import { perfumesConfig } from './config.js';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

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

const URLS_EXP = {
  json: 'A readable JSON object',
  nonEmpty: 'Contains at least one URL',
  urls: 'Every value is a Fragrantica URL',
};

/**
 * find-url → fetch boundary: the id→Fragrantica-URL map. Must exist, parse as a
 * non-empty JSON object, and every value must be a Fragrantica URL (the expected
 * field shape — a layout change that stops emitting real URLs fails here).
 */
export function fragranticaUrlsContract(file: string = perfumesConfig.urlsFile): ArtifactContract {
  return {
    key: 'fragrantica-urls',
    description: 'find-url output: { perfumeId: fragranticaUrl } — non-empty, real Fragrantica URLs.',
    shape: {
      summary: 'A lookup of each perfume id to its Fragrantica page URL.',
      format: 'JSON object { perfumeId: url }',
      expectations: [
        { label: URLS_EXP.json, detail: 'The hand-off file exists and parses as a JSON object.' },
        { label: URLS_EXP.nonEmpty, detail: 'At least one id→URL entry — otherwise nothing to fetch.' },
        { label: URLS_EXP.urls, detail: 'Each value points at fragrantica.com (a layout change that stops emitting real URLs is caught here).' },
      ],
    },
    check(): GateResult {
      const checks: ExpectationResult[] = [];
      if (!existsSync(file)) {
        checks.push({ label: URLS_EXP.json, ok: false, actual: `urls file missing: ${file}` });
        return fromChecks(checks);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8'));
      } catch (e) {
        checks.push({ label: URLS_EXP.json, ok: false, actual: `not valid JSON — ${errMsg(e)}` });
        return fromChecks(checks);
      }
      const isObj = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
      checks.push({ label: URLS_EXP.json, ok: isObj, actual: isObj ? 'valid JSON object' : 'not a JSON object of id→url' });
      if (!isObj) return fromChecks(checks);
      const entries = Object.entries(parsed as Record<string, unknown>);
      checks.push({ label: URLS_EXP.nonEmpty, ok: entries.length > 0, actual: `${entries.length} URL(s)` });
      const bad = entries.find(
        ([, v]) => typeof v !== 'string' || !/^https?:\/\/[^\s]*fragrantica\.com\//i.test(v),
      );
      checks.push({
        label: URLS_EXP.urls,
        ok: !bad,
        actual: bad ? `entry "${bad[0]}" is not a Fragrantica URL: ${JSON.stringify(bad[1])}` : 'all Fragrantica URLs',
      });
      const first = entries[0]?.[1];
      const sample = entries.length
        ? `${entries.length} URL(s)${typeof first === 'string' ? ` · e.g. ${first}` : ''}`
        : undefined;
      return fromChecks(checks, sample);
    },
  };
}

const PAGES_EXP = {
  exists: 'The pages folder exists',
  hasTxt: 'Contains at least one captured page (.txt)',
  nonEmpty: 'At least one captured page is non-empty',
};

/**
 * fetch → parse boundary: the captured page texts. The directory must hold at
 * least one non-empty `<id>.txt` (a blocked/empty scrape leaves nothing useful
 * for the parser).
 */
export function fragranticaPagesContract(dir: string = perfumesConfig.pagesDir): ArtifactContract {
  return {
    key: 'fragrantica-pages',
    description: 'fetch output: data/out/pages/<id>.txt — at least one non-empty captured page.',
    shape: {
      summary: 'The raw Fragrantica page text captured for each perfume.',
      format: 'Folder of <id>.txt page captures',
      expectations: [
        { label: PAGES_EXP.exists, detail: 'The output folder was created.' },
        { label: PAGES_EXP.hasTxt, detail: 'At least one page was saved as a .txt file.' },
        { label: PAGES_EXP.nonEmpty, detail: 'At least one capture has content — a blocked/empty scrape leaves nothing for the parser.' },
      ],
    },
    check(): GateResult {
      const checks: ExpectationResult[] = [];
      if (!existsSync(dir)) {
        checks.push({ label: PAGES_EXP.exists, ok: false, actual: `pages dir missing: ${dir}` });
        return fromChecks(checks);
      }
      checks.push({ label: PAGES_EXP.exists, ok: true, actual: 'present' });
      const txts = readdirSync(dir).filter((f) => f.endsWith('.txt'));
      checks.push({ label: PAGES_EXP.hasTxt, ok: txts.length > 0, actual: `${txts.length} .txt file(s)` });
      if (txts.length === 0) return fromChecks(checks);
      const nonEmpty = txts.filter((f) => statSync(resolve(dir, f)).size > 0);
      checks.push({
        label: PAGES_EXP.nonEmpty,
        ok: nonEmpty.length > 0,
        actual: nonEmpty.length > 0 ? `${nonEmpty.length}/${txts.length} non-empty` : `all ${txts.length} page(s) empty`,
      });
      return fromChecks(checks, `${nonEmpty.length}/${txts.length} non-empty page(s)`);
    },
  };
}

const DATA_EXP = {
  exists: 'The parsed-data folder exists',
  hasJson: 'Contains at least one parsed perfume (.json)',
  shape: 'At least one perfume has a name and a notes object',
};

/**
 * parse → build boundary: the structured Fragrantica JSON. At least one parsed
 * `<id>.json` must exist with the expected shape (a non-empty `name` and a
 * `notes` object) — a parse that yields shapeless blobs fails here.
 */
export function fragranticaDataContract(dir: string = perfumesConfig.fragranticaDir): ArtifactContract {
  return {
    key: 'fragrantica-data',
    description: 'parse output: data/out/fragrantica/<id>.json — at least one parsed perfume with name + notes.',
    shape: {
      summary: 'Each captured page parsed into a structured perfume record.',
      format: 'Folder of <id>.json parsed perfumes',
      expectations: [
        { label: DATA_EXP.exists, detail: 'The output folder was created.' },
        { label: DATA_EXP.hasJson, detail: 'At least one perfume was parsed to a .json file.' },
        { label: DATA_EXP.shape, detail: 'A representative record has a text name and a notes object — a parse that yields shapeless blobs is caught here.' },
      ],
    },
    check(): GateResult {
      const checks: ExpectationResult[] = [];
      if (!existsSync(dir)) {
        checks.push({ label: DATA_EXP.exists, ok: false, actual: `fragrantica dir missing: ${dir}` });
        return fromChecks(checks);
      }
      checks.push({ label: DATA_EXP.exists, ok: true, actual: 'present' });
      const jsons = readdirSync(dir).filter((f) => f.endsWith('.json'));
      checks.push({ label: DATA_EXP.hasJson, ok: jsons.length > 0, actual: `${jsons.length} parsed file(s)` });
      if (jsons.length === 0) return fromChecks(checks);
      // A format drift is systemic, so a representative well-formed record is
      // enough: pass if ANY parsed file has the expected shape; otherwise report
      // why the first one failed.
      let firstReason = '';
      for (const f of jsons.sort()) {
        let obj: unknown;
        try {
          obj = JSON.parse(readFileSync(resolve(dir, f), 'utf8'));
        } catch (e) {
          firstReason ||= `${f}: not valid JSON — ${errMsg(e)}`;
          continue;
        }
        const rec = obj as Record<string, unknown>;
        if (!rec || typeof rec.name !== 'string' || !rec.name.trim()) {
          firstReason ||= `${f}: missing/empty "name"`;
          continue;
        }
        if (!rec.notes || typeof rec.notes !== 'object' || Array.isArray(rec.notes)) {
          firstReason ||= `${f}: missing "notes" object`;
          continue;
        }
        checks.push({ label: DATA_EXP.shape, ok: true, actual: `e.g. "${rec.name}" with notes` });
        return fromChecks(checks, `${jsons.length} parsed perfume(s)`);
      }
      checks.push({ label: DATA_EXP.shape, ok: false, actual: `no record has the expected shape — ${firstReason}` });
      return fromChecks(checks);
    },
  };
}
