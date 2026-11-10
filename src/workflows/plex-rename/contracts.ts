// The data the plex-rename stages hand to each other. It all travels in the
// work_items ledger: each stage's rows ARE its output, so these are ledger
// artifacts (no hand-off files).
//
//   discover ──files──▶ plan ──plan──▶ verify ──verdicts──▶ apply ──applied──▶ confirm
//      ├───────────────files─────────────▲                     ▲                  ▲
//      ├───────────────────────files───────────────────────────┘                  │
//      └───────────────────────────────files──────────────────────────────────────┘
//
// verify, apply and confirm each read the discover rows as well (the Plex-side
// record of every file), so each depends on discover directly.
//
// Two of the checks are real pre-mutation bars, not "the ledger is readable":
// the plan's rename rows and the verify stage's eligible rows are what the one
// stage that moves files relies on.
import { fromChecks, ledgerArtifact, successRows } from '../../engine/index.js';
import type { LedgerRowValue } from '../../engine/index.js';
import { pathKey } from './naming.js';
import type { ApplyDetail, DiscoverDetail, PlanDetail, VerifyDetail } from './types.js';

const READABLE = 'The ledger is readable (the library may legitimately be empty).';
const named = (r: LedgerRowValue) => String((r.detail as { name?: unknown } | null)?.name ?? r.itemKey);

/** Every physical file across the configured Plex sections, re-recorded as a snapshot every run. */
export const discoveredFiles = ledgerArtifact({
  key: 'plex-rename-discover',
  description: 'Every physical library file (movie or episode) as Plex sees it: path, size, ids and naming metadata. One ledger row per file, re-recorded every run.',
  shape: {
    summary: 'Every physical file across the configured Plex sections, as a fresh snapshot.',
    format: 'work_items ledger rows for job "plex-rename-discover"',
    expectations: [{ label: READABLE, detail: 'The ledger for this job is queryable.' }],
  },
  readRows: successRows,
  check: (rows) => fromChecks([{ label: READABLE, ok: true, actual: `${rows.length} file snapshot(s)` }], `${rows.length} file(s)`),
  summary: (rows) => `${rows.length} file(s)`,
  items: (rows) => rows.map((r) => {
    const d = r.detail as DiscoverDetail | null;
    return { id: r.itemKey, title: named(r), fields: d ? [{ label: 'Kind', value: d.kind }, { label: 'File', value: d.file }] : [] };
  }),
});

const RENAMES_WELL_FORMED =
  'Every "rename" decision has a non-empty from and to, from ≠ to, the target stays under its declared target root (the file\'s own, or the show\'s consolidated home root for a cross-share move), and no two rows share a target.';

/** Each file's decision: rename it (with the exact from and to), it is already canonical, or skip it. */
export const renamePlan = ledgerArtifact({
  key: 'plex-rename-plan',
  description: 'Each file\'s decision: rename (with the exact from and to), already canonical, or skip. One ledger row per file.',
  shape: {
    summary: "Every file's canonical-rename decision, with the exact from → to for rename rows.",
    format: 'work_items ledger rows for job "plex-rename-plan"',
    expectations: [{ label: RENAMES_WELL_FORMED, detail: 'The bar verify (and ultimately apply) relies on.' }],
  },
  readRows: successRows,
  check(rows) {
    const offenders: string[] = [];
    const targets = new Map<string, string>();
    let renameCount = 0;
    for (const row of rows) {
      const d = row.detail as PlanDetail | null;
      if (d?.decision !== 'rename') continue;
      renameCount++;
      const fromOk = typeof d.from === 'string' && d.from.length > 0;
      const toOk = typeof d.to === 'string' && d.to.length > 0;
      const differs = fromOk && toOk && d.from !== d.to;
      const targetRoot = d.targetRootPath ?? d.rootPath;
      const underRoot = toOk && typeof targetRoot === 'string' && targetRoot.length > 0 && pathKey(d.to!).startsWith(pathKey(targetRoot));
      if (!fromOk || !toOk || !differs || !underRoot) {
        offenders.push(row.itemKey);
        continue;
      }
      const tKey = pathKey(d.to!);
      const prior = targets.get(tKey);
      if (prior) offenders.push(`${prior}+${row.itemKey} (duplicate target)`);
      else targets.set(tKey, row.itemKey);
    }
    const ok = offenders.length === 0;
    const actual = ok
      ? `${renameCount} rename row(s), all well-formed and collision-free`
      : `${offenders.length} malformed rename row(s): ${offenders.slice(0, 5).join(', ')}${offenders.length > 5 ? ', …' : ''}`;
    return fromChecks([{ label: RENAMES_WELL_FORMED, ok, actual }], `${rows.length} decision(s)`);
  },
  summary: (rows) => `${rows.length} decision(s), ${rows.filter((r) => (r.detail as PlanDetail | null)?.decision === 'rename').length} to rename`,
  items: (rows) => rows.map((r) => {
    const d = r.detail as PlanDetail | null;
    return { id: r.itemKey, title: named(r), fields: [{ label: 'Decision', value: String(d?.decision ?? '?') }, ...(d?.to ? [{ label: 'To', value: d.to }] : [])] };
  }),
});

const ELIGIBLE_APPLIABLE =
  'Every eligible row has both local paths mapped under configured shares (cross-share consolidation moves are legitimate), verified bytes > 0, a well-formed sidecar list, and localFrom ≠ localTo unless case-only.';

/** Each rename candidate's verdict from the local disk. The eligible rows are what apply acts on. */
export const renameVerdicts = ledgerArtifact({
  key: 'plex-rename-verify',
  description: 'Each rename candidate checked against the local disk: eligible or not, with the verified size and the sidecar files that move with it.',
  shape: {
    summary: "Every rename candidate's local-disk eligibility verdict, with verified sizes and sidecar moves.",
    format: 'work_items ledger rows for job "plex-rename-verify"',
    expectations: [{ label: ELIGIBLE_APPLIABLE, detail: 'The pre-mutation bar apply relies on before moving any file.' }],
  },
  readRows: successRows,
  check(rows) {
    const offenders: string[] = [];
    let eligibleCount = 0;
    for (const row of rows) {
      const d = row.detail as VerifyDetail | null;
      if (!d?.eligible) continue;
      eligibleCount++;
      const pathsOk = typeof d.localFrom === 'string' && d.localFrom.length > 0 && typeof d.localTo === 'string' && d.localTo.length > 0;
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
    return fromChecks([{ label: ELIGIBLE_APPLIABLE, ok, actual }], `${rows.length} verdict(s)`);
  },
  summary: (rows) => `${rows.length} verdict(s), ${rows.filter((r) => (r.detail as VerifyDetail | null)?.eligible).length} eligible`,
  items: (rows) => rows.map((r) => {
    const d = r.detail as VerifyDetail | null;
    return { id: r.itemKey, title: named(r), fields: [{ label: 'Eligible', value: d?.eligible ? 'yes' : `no${d?.reason ? ` (${d.reason})` : ''}` }] };
  }),
});

/** Every file that has been moved and checksum-verified, ever. A file is moved once. */
export const appliedRenames = ledgerArtifact({
  key: 'plex-rename-apply',
  description: 'Every file that has been moved to its canonical path and checksum-verified, with its final path and hash. A file is moved once, ever.',
  shape: {
    summary: 'Every applied (moved + checksum-verified) file, with its final path and hash.',
    format: 'work_items ledger rows for job "plex-rename-apply"',
    expectations: [{ label: READABLE, detail: 'The ledger for this job is queryable.' }],
  },
  readRows: successRows,
  check: (rows) => fromChecks([{ label: READABLE, ok: true, actual: `${rows.length} applied item(s)` }], `${rows.length} item(s)`),
  summary: (rows) => `${rows.length} file(s) moved`,
  items: (rows) => rows.map((r) => {
    const d = r.detail as ApplyDetail | null;
    return { id: r.itemKey, title: named(r), fields: d?.to ? [{ label: 'Now at', value: d.to }] : [] };
  }),
});

/** Which moved files Plex has been confirmed to see at their new path. */
export const confirmedRenames = ledgerArtifact({
  key: 'plex-rename-confirm',
  description: 'Each moved file that Plex has been confirmed to see at its new path. One ledger row per confirmed file.',
  readRows: successRows,
  check: (rows) => fromChecks([{ label: READABLE, ok: true, actual: `${rows.length} confirmed` }], `${rows.length} confirmed`),
  summary: (rows) => `${rows.length} confirmed`,
  items: (rows) => rows.map((r) => ({ id: r.itemKey, title: named(r) })),
});
