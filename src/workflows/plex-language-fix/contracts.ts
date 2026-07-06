// Typed-artifact contract for the language scan output — the gate on the
// plex-language-scan → plex-language-apply DAG edge. Both sides reuse the SAME
// factory (the established convention in this repo when both sides of an edge
// assert the same shape — see root CLAUDE.md's gate-collapse note).
import { existsSync, readFileSync } from 'node:fs';
import type { ArtifactContract, ExpectationResult, GateResult } from '../../core/types.js';
import { plexLanguageFixConfig } from './config.js';
import type { LanguageScanFile } from './types.js';

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

const EXP = {
  json: 'A readable language-scan JSON object',
  items: 'Contains the items array',
};

/** scan output boundary: the per-title language-scan changeset. */
export function plexLanguageScanContract(file: string = plexLanguageFixConfig.scanOut): ArtifactContract {
  return {
    key: 'plex-language-scan',
    description: 'scan output: { items: [{ title, originalLanguage, files: [{ status, currentAudio, proposedAudio, ... }] }] } — readable, non-empty.',
    shape: {
      summary: 'The full per-title language scan: every show/movie file with its current vs proposed audio/subtitle.',
      format: 'JSON object { generatedAt, sectionsScanned[], items[] }',
      expectations: [
        { label: EXP.json, detail: 'The scan file exists and parses as a JSON object.' },
        { label: EXP.items, detail: 'It has an `items` array (the library may legitimately be empty).' },
      ],
    },
    check(): GateResult {
      const checks: ExpectationResult[] = [];
      if (!existsSync(file)) {
        checks.push({ label: EXP.json, ok: false, actual: `scan output missing: ${file}` });
        return fromChecks(checks);
      }
      let parsed: LanguageScanFile;
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8')) as LanguageScanFile;
      } catch (e) {
        checks.push({ label: EXP.json, ok: false, actual: `not valid JSON — ${errMsg(e)}` });
        return fromChecks(checks);
      }
      checks.push({ label: EXP.json, ok: true, actual: 'valid JSON object' });
      const items = Array.isArray(parsed.items) ? parsed.items : null;
      checks.push({ label: EXP.items, ok: !!items, actual: items ? `${items.length} item(s)` : 'no items array' });
      if (!items) return fromChecks(checks);
      return fromChecks(checks, `${items.length} item(s)`);
    },
  };
}
