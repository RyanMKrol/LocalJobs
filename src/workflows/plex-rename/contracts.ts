// Typed-artifact contracts for the plex-rename DAG:
// plex-rename-discover → plex-rename-plan → plex-rename-verify → (plex-rename-apply → plex-rename-confirm).
// The stages chain through the per-item work_items ledger (no shared file), so
// each check() reads the ledger read-only via stages/ledger.ts — never a
// paid/remote call, never the disk. The two gates guarding the path INTO the
// mutating apply stage are REAL shape checks (the T574 pattern), not the
// trivial minimum: a drift in plan/verify logic must fail LOUD at the
// boundary, never quietly reach a stage that moves the owner's files.
import type { ArtifactContract, ExpectationResult, GateResult } from '../../core/types.js';
import { pathKey } from './naming.js';
import type { PlanDetail, VerifyDetail } from './types.js';
import { ledgerSuccessCount, ledgerSuccessRows } from './stages/ledger.js';

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

const EXP_RECORDED = 'The ledger is readable (the library may legitimately be empty).';

/** discover → plan boundary: the per-file snapshot ledger. */
export function plexRenameDiscoverContract(): ArtifactContract {
  return {
    key: 'plex-rename-discover',
    description:
      'discover output: one work_items row per physical library file, keyed "<ratingKey>::part<partId>", ' +
      'detail carrying the Plex-side path, size, ids, and naming metadata — re-recorded (snapshot) every run.',
    shape: {
      summary: 'Every physical file (movie or TV episode) across the configured Plex sections, as a fresh snapshot.',
      format: 'work_items ledger rows for job "plex-rename-discover"',
      expectations: [{ label: EXP_RECORDED, detail: 'The ledger for this job is queryable.' }],
    },
    check(): GateResult {
      const n = ledgerSuccessCount('plex-rename-discover');
      return fromChecks([{ label: EXP_RECORDED, ok: true, actual: `${n} file snapshot(s)` }], `${n} file(s)`);
    },
  };
}

const EXP_RENAME_ROWS_WELL_FORMED =
  'Every "rename" decision has a non-empty from and to, from ≠ to, the target stays under the file\'s own library root, and no two rows share a target.';

/** plan → verify boundary: a REAL check on every rename decision's shape. */
export function plexRenamePlanContract(): ArtifactContract {
  return {
    key: 'plex-rename-plan',
    description:
      'plan output: one work_items row per file with decision rename/already-canonical/skip; every "rename" row ' +
      'carries from + to + rootPath + engine ops. Rename rows must be well-formed: from ≠ to, target under the ' +
      'file\'s own library root, and globally collision-free.',
    shape: {
      summary: "Every file's canonical-rename decision, with the exact from → to for rename rows.",
      format: 'work_items ledger rows for job "plex-rename-plan"',
      expectations: [{ label: EXP_RENAME_ROWS_WELL_FORMED, detail: 'The bar verify (and ultimately apply) relies on.' }],
    },
    check(): GateResult {
      const rows = ledgerSuccessRows('plex-rename-plan');
      const offenders: string[] = [];
      const targets = new Map<string, string>();
      let renameCount = 0;
      for (const row of rows) {
        const d = row.detail as PlanDetail;
        if (d?.decision !== 'rename') continue;
        renameCount++;
        const fromOk = typeof d.from === 'string' && d.from.length > 0;
        const toOk = typeof d.to === 'string' && d.to.length > 0;
        const differs = fromOk && toOk && d.from !== d.to;
        const underRoot = toOk && typeof d.rootPath === 'string' && d.rootPath.length > 0 && pathKey(d.to!).startsWith(pathKey(d.rootPath));
        if (!fromOk || !toOk || !differs || !underRoot) {
          offenders.push(row.itemKey);
          continue;
        }
        const tKey = pathKey(d.to!);
        const prior = targets.get(tKey);
        if (prior) {
          offenders.push(`${prior}+${row.itemKey} (duplicate target)`);
        } else {
          targets.set(tKey, row.itemKey);
        }
      }
      const ok = offenders.length === 0;
      const actual = ok
        ? `${renameCount} rename row(s), all well-formed and collision-free`
        : `${offenders.length} malformed rename row(s): ${offenders.slice(0, 5).join(', ')}${offenders.length > 5 ? ', …' : ''}`;
      return fromChecks([{ label: EXP_RENAME_ROWS_WELL_FORMED, ok, actual }], `${rows.length} decision(s)`);
    },
  };
}

/** apply → confirm boundary: the sanctioned trivial minimum (apply's own ledger is the artifact). */
export function plexRenameApplyContract(): ArtifactContract {
  return {
    key: 'plex-rename-apply',
    description:
      'apply output: one work_items row per moved file (once-ever), detail { name, from, to, sha256, bytes, ' +
      'sidecarCount, appliedAt } — the record confirm re-checks against live Plex.',
    shape: {
      summary: 'Every applied (moved + checksum-verified) file, with its final path and hash.',
      format: 'work_items ledger rows for job "plex-rename-apply"',
      expectations: [{ label: EXP_RECORDED, detail: 'The ledger for this job is queryable.' }],
    },
    check(): GateResult {
      const n = ledgerSuccessCount('plex-rename-apply');
      return fromChecks([{ label: EXP_RECORDED, ok: true, actual: `${n} applied item(s)` }], `${n} item(s)`);
    },
  };
}

const EXP_ELIGIBLE_ROWS_APPLIABLE =
  'Every eligible row has local paths mapped under the SAME share, verified bytes > 0, a well-formed sidecar list, and localFrom ≠ localTo unless case-only.';

/**
 * verify → apply boundary: THE pre-mutation gate. Asserts exactly the
 * malformations apply would otherwise have to silently skip — they fail loud
 * here instead, before any file is touched.
 */
export function plexRenameVerifyContract(): ArtifactContract {
  return {
    key: 'plex-rename-verify',
    description:
      'verify output: one work_items row per rename candidate with the on-disk eligibility verdict; every ' +
      '"eligible" row carries localFrom/localTo (same share), verified bytes, the enumerated sidecar moves, and ' +
      'the optional .plexmatch write — the exact preconditions the mutating apply stage relies on.',
    shape: {
      summary: "Every rename candidate's local-disk eligibility verdict, with verified sizes and sidecar moves.",
      format: 'work_items ledger rows for job "plex-rename-verify"',
      expectations: [{ label: EXP_ELIGIBLE_ROWS_APPLIABLE, detail: 'The pre-mutation bar apply relies on before moving any file.' }],
    },
    check(): GateResult {
      const rows = ledgerSuccessRows('plex-rename-verify');
      const offenders: string[] = [];
      let eligibleCount = 0;
      for (const row of rows) {
        const d = row.detail as VerifyDetail;
        if (!d?.eligible) continue;
        eligibleCount++;
        const pathsOk =
          typeof d.localFrom === 'string' && d.localFrom.length > 0 && typeof d.localTo === 'string' && d.localTo.length > 0;
        const differOk = pathsOk && (d.localFrom !== d.localTo || d.caseOnly === true);
        const bytesOk = typeof d.bytes === 'number' && d.bytes > 0;
        const sidecarsOk =
          Array.isArray(d.sidecars) &&
          d.sidecars.every((s) => typeof s.from === 'string' && s.from.length > 0 && typeof s.to === 'string' && s.to.length > 0);
        if (!pathsOk || !differOk || !bytesOk || !sidecarsOk) offenders.push(row.itemKey);
      }
      const ok = offenders.length === 0;
      const actual = ok
        ? `${eligibleCount} eligible row(s), all appliable`
        : `${offenders.length} malformed eligible row(s): ${offenders.slice(0, 5).join(', ')}${offenders.length > 5 ? ', …' : ''}`;
      return fromChecks([{ label: EXP_ELIGIBLE_ROWS_APPLIABLE, ok, actual }], `${rows.length} verdict(s)`);
    },
  };
}
