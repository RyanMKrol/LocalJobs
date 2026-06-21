// Typed-artifact contracts for the perfumes pipeline stage boundaries.
//
// Each factory returns an ArtifactContract whose `check()` inspects the REAL
// artifact left on disk and reports SHAPE + NON-EMPTY drift — enough to catch a
// Fragrantica format change or an empty/missing hand-off without brittle
// full-schema validation. The factories take an optional path so they can be
// unit-tested against synthetic fixtures (the jobs use the default data paths).
//
// Keys are shared across the producing job's `produces` and the consuming job's
// `consumes` so the pipeline executor derives a gate at each edge:
//   find-url ──fragrantica-urls──▶ fetch ──fragrantica-pages──▶ parse
//            ──fragrantica-data──▶ build
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ArtifactContract, GateResult } from '../../core/types.js';
import { perfumesConfig } from './config.js';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * find-url → fetch boundary: the id→Fragrantica-URL map. Must exist, parse as a
 * non-empty JSON object, and every value must be a Fragrantica URL (the expected
 * field shape — a layout change that stops emitting real URLs fails here).
 */
export function fragranticaUrlsContract(file: string = perfumesConfig.urlsFile): ArtifactContract {
  return {
    key: 'fragrantica-urls',
    description: 'find-url output: { perfumeId: fragranticaUrl } — non-empty, real Fragrantica URLs.',
    check(): GateResult {
      if (!existsSync(file)) return { ok: false, violations: [`urls file missing: ${file}`] };
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8'));
      } catch (e) {
        return { ok: false, violations: [`urls file is not valid JSON — ${errMsg(e)}`] };
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, violations: ['urls file is not a JSON object of id→url'] };
      }
      const entries = Object.entries(parsed as Record<string, unknown>);
      if (entries.length === 0) return { ok: false, violations: ['urls file is empty — no URLs found'] };
      const bad = entries.find(
        ([, v]) => typeof v !== 'string' || !/^https?:\/\/[^\s]*fragrantica\.com\//i.test(v),
      );
      if (bad) return { ok: false, violations: [`entry "${bad[0]}" is not a Fragrantica URL: ${JSON.stringify(bad[1])}`] };
      return { ok: true, detail: `${entries.length} Fragrantica URL(s)` };
    },
  };
}

/**
 * fetch → parse boundary: the captured page texts. The directory must hold at
 * least one non-empty `<id>.txt` (a blocked/empty scrape leaves nothing useful
 * for the parser).
 */
export function fragranticaPagesContract(dir: string = perfumesConfig.pagesDir): ArtifactContract {
  return {
    key: 'fragrantica-pages',
    description: 'fetch output: data/out/pages/<id>.txt — at least one non-empty captured page.',
    check(): GateResult {
      if (!existsSync(dir)) return { ok: false, violations: [`pages dir missing: ${dir}`] };
      const txts = readdirSync(dir).filter((f) => f.endsWith('.txt'));
      if (txts.length === 0) return { ok: false, violations: ['no captured pages (.txt) found'] };
      const nonEmpty = txts.filter((f) => statSync(resolve(dir, f)).size > 0);
      if (nonEmpty.length === 0) return { ok: false, violations: [`all ${txts.length} captured page(s) are empty`] };
      return { ok: true, detail: `${nonEmpty.length}/${txts.length} non-empty page(s)` };
    },
  };
}

/**
 * parse → build boundary: the structured Fragrantica JSON. At least one parsed
 * `<id>.json` must exist with the expected shape (a non-empty `name` and a
 * `notes` object) — a parse that yields shapeless blobs fails here.
 */
export function fragranticaDataContract(dir: string = perfumesConfig.fragranticaDir): ArtifactContract {
  return {
    key: 'fragrantica-data',
    description: 'parse output: data/out/fragrantica/<id>.json — at least one parsed perfume with name + notes.',
    check(): GateResult {
      if (!existsSync(dir)) return { ok: false, violations: [`fragrantica dir missing: ${dir}`] };
      const jsons = readdirSync(dir).filter((f) => f.endsWith('.json'));
      if (jsons.length === 0) return { ok: false, violations: ['no parsed perfume JSON found'] };
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
        return { ok: true, detail: `${jsons.length} parsed perfume(s)` };
      }
      return { ok: false, violations: [`no parsed perfume has the expected shape — ${firstReason}`] };
    },
  };
}
