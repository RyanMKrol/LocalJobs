import type { JobContext } from '../../../core/types.js';
import { markWorkItem, pruneSnapshotRows } from '../../../db/store.js';
import { plexRenameConfig } from '../config.js';
import { mountHealthy, plexToLocal, realReadFs, shareOf, type ReadFsSeam } from '../lib.js';
import { pathKey, planSidecars, posixBasename, posixDirname, splitExt, type NamingOp } from '../naming.js';
import type { DiscoverDetail, PathMapPair, PlanDetail, SidecarMove, VerifyDetail, VerifyIneligibleReason } from '../types.js';
import { ledgerSuccessRows } from './ledger.js';

export const JOB_NAME = 'plex-rename-verify';
export const PLAN_JOB = 'plex-rename-plan';
export const DISCOVER_JOB = 'plex-rename-discover';

/** Injectable seams for tests. */
export interface VerifyOverrides {
  fs?: ReadFsSeam;
  readPlanRows?: () => { itemKey: string; detail: unknown }[];
  readDiscoverRows?: () => { itemKey: string; detail: unknown }[];
  pathMap?: PathMapPair[];
  minAgeDays?: number;
  now?: () => number;
}

function ineligible(
  base: Pick<VerifyDetail, 'name' | 'from' | 'to' | 'localFrom' | 'localTo'>,
  reason: VerifyIneligibleReason,
  reasonDetail: string,
): VerifyDetail {
  return { ...base, eligible: false, reason, reasonDetail };
}

/**
 * The local-disk reality check — the ONLY read stage that touches the
 * filesystem, recomputed every run. For every `rename` plan row it asserts the
 * disk is EXACTLY as expected before the item may reach the mutating apply
 * stage: mounts healthy (non-empty dir — a stale empty mountpoint is treated
 * as missing, never as deleted files), paths mappable and same-share, source
 * present with Plex's exact recorded size, mtime older than the
 * still-downloading window, target absent (except case-only renames), the
 * REAL directory listing's sidecars enumerated with collision checks, and
 * `.plexmatch` never clobbered (source tree or divergent target → ineligible).
 */
export async function runVerify(ctx: JobContext, opts: VerifyOverrides = {}): Promise<void> {
  const fs = opts.fs ?? realReadFs;
  const readPlanRows = opts.readPlanRows ?? (() => ledgerSuccessRows(PLAN_JOB));
  const readDiscoverRows = opts.readDiscoverRows ?? (() => ledgerSuccessRows(DISCOVER_JOB));
  const pathMap = opts.pathMap ?? plexRenameConfig.pathMap;
  const minAgeDays = opts.minAgeDays ?? plexRenameConfig.minAgeDays;
  const now = opts.now ?? Date.now;

  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log('plex-rename-verify starting — read-only local-disk reality check, recomputed every run.');
  ctx.log(`Path map: ${pathMap.map((p) => `${p.plex} → ${p.local}`).join(' ; ') || 'EMPTY — set PLEX_RENAME_PATH_MAP; every item will be unmapped-path'}`);
  ctx.log(`Still-downloading guard: files modified within ${minAgeDays} day(s) are ineligible.`);

  // Mount preflight — once per mapped share.
  const mountOk = new Map<string, boolean>();
  for (const pair of pathMap) {
    const healthy = await mountHealthy(pair.local, fs);
    mountOk.set(pathKey(pair.plex), healthy);
    ctx.log(healthy ? `  ✓ mount healthy: ${pair.local}` : `  ✗ mount MISSING/unhealthy: ${pair.local} (share ${pair.plex}) — its items stay ineligible this run`, healthy ? 'info' : 'warn');
  }

  const discoverByKey = new Map<string, DiscoverDetail>();
  for (const row of readDiscoverRows()) discoverByKey.set(row.itemKey, row.detail as DiscoverDetail);

  const planRows = readPlanRows().filter((r) => (r.detail as PlanDetail)?.decision === 'rename');
  ctx.log(`Rename-decision plan rows to verify: ${planRows.length}`);
  ctx.progress(5, `${planRows.length} candidate(s)`);

  const minAgeMs = minAgeDays * 24 * 60 * 60 * 1000;
  let eligibleCount = 0;
  const reasonCounts = new Map<string, number>();

  let index = 0;
  for (const row of planRows) {
    index++;
    if (!ctx.rootAllowed(row.itemKey)) continue;
    const plan = row.detail as PlanDetail;
    const discover = discoverByKey.get(row.itemKey);
    const base = { name: plan.name, from: plan.from, to: plan.to ?? '' };

    const record = (detail: VerifyDetail) => {
      markWorkItem(JOB_NAME, row.itemKey, 'success', { detail });
      if (detail.eligible) {
        eligibleCount++;
        ctx.log(
          `  ✓ eligible "${detail.name}"${detail.caseOnly ? ' (case-only)' : ''} — ${detail.bytes ?? '?'} bytes on disk (matches Plex)` +
            `${detail.plexmatch ? ' · will write .plexmatch' : ''}`,
        );
        ctx.log(`      local: ${detail.localFrom} → ${detail.localTo}`);
        for (const s of detail.sidecars ?? []) ctx.log(`      sidecar rides along: ${s.from} → ${s.to} [${s.role}]`);
        if ((detail.leftBehind ?? []).length > 0) ctx.log(`      left behind: ${detail.leftBehind!.join(' · ')}`);
      } else {
        reasonCounts.set(detail.reason!, (reasonCounts.get(detail.reason!) ?? 0) + 1);
        ctx.log(`  ⊘ ineligible (${detail.reason}) "${detail.name}" — ${detail.reasonDetail}`, detail.reason === 'file-missing' ? 'warn' : 'info');
      }
      if (index % 50 === 0) ctx.progress(5 + Math.round((90 * index) / planRows.length), `${index}/${planRows.length} verified`);
    };

    if (!plan.to || !discover) {
      record(ineligible(base, 'not-a-rename', 'plan row lacks a target or its discover snapshot is missing'));
      continue;
    }

    // ── Path mapping ──
    // Cross-share targets are LEGITIMATE (a split show consolidating to its
    // home share) — the copy → verify → delete move procedure crosses shares
    // as safely as it moves within one. Both sides just need mapped, healthy
    // mounts.
    const fromShare = shareOf(plan.from, pathMap);
    const toShare = shareOf(plan.to, pathMap);
    const localFrom = plexToLocal(plan.from, pathMap);
    const localTo = plexToLocal(plan.to, pathMap);
    if (!fromShare || !toShare || !localFrom || !localTo) {
      record(ineligible(base, 'unmapped-path', `no PLEX_RENAME_PATH_MAP prefix covers ${!fromShare ? plan.from : plan.to}`));
      continue;
    }
    const withLocal = { ...base, localFrom, localTo };

    // ── Mount health (BOTH sides — the source share and the target share) ──
    if (!mountOk.get(pathKey(fromShare.plex))) {
      record(ineligible(withLocal, 'mount-missing', `source share ${fromShare.local} is not mounted/healthy — routine skip, NOT a missing file`));
      continue;
    }
    if (!mountOk.get(pathKey(toShare.plex))) {
      record(ineligible(withLocal, 'mount-missing', `target share ${toShare.local} is not mounted/healthy — routine skip`));
      continue;
    }

    // ── Source file state ──
    const st = await fs.stat(localFrom);
    if (!st || !st.isFile) {
      record(ineligible(withLocal, 'file-missing', `mount is healthy but ${localFrom} does not exist — investigate before anything mutates`));
      continue;
    }
    if (discover.partSize === undefined) {
      record(ineligible(withLocal, 'size-unknown', 'Plex reported no Part.size — integrity cannot be verified'));
      continue;
    }
    if (st.size !== discover.partSize) {
      record(
        ineligible(withLocal, 'size-mismatch', `disk size ${st.size} ≠ Plex-recorded size ${discover.partSize} — file changed underneath us`),
      );
      continue;
    }
    const age = now() - st.mtimeMs;
    if (age < minAgeMs) {
      record(
        ineligible(withLocal, 'too-recent', `modified ${(age / 86_400_000).toFixed(1)} day(s) ago (< ${minAgeDays}d window) — possibly still downloading`),
      );
      continue;
    }

    // ── Target state ──
    const caseOnly = pathKey(plan.from) === pathKey(plan.to);
    if (!caseOnly) {
      const targetSt = await fs.stat(localTo);
      if (targetSt) {
        record(ineligible(withLocal, 'target-exists', `${localTo} already exists — never overwritten`));
        continue;
      }
    }

    // ── Sidecars from the REAL directory listing ──
    const localDir = posixDirname(localFrom);
    const plexDir = posixDirname(plan.from);
    const newPlexDir = posixDirname(plan.to);
    const listing = (await fs.readdir(localDir)) ?? [];
    const mediaName = posixBasename(plan.from);
    const sidecarPlan = planSidecars(
      plexDir,
      splitExt(mediaName).stem,
      newPlexDir,
      splitExt(posixBasename(plan.to)).stem,
      listing.map((e) => ({ name: e.name, isDir: e.isDir })),
      { moveFixedAssets: discover.kind === 'movie', mediaName },
    );
    let sidecarCollision: string | null = null;
    for (const s of sidecarPlan.moves) {
      if (pathKey(s.from) === pathKey(s.to)) continue;
      const localSidecarTo = plexToLocal(s.to, pathMap);
      if (!localSidecarTo) continue;
      const scSt = await fs.stat(localSidecarTo);
      if (scSt) {
        sidecarCollision = s.to;
        break;
      }
    }
    if (sidecarCollision) {
      record(ineligible(withLocal, 'sidecar-collision', `sidecar target already exists: ${sidecarCollision} — all-or-nothing per item`));
      continue;
    }
    const sidecars: SidecarMove[] = sidecarPlan.moves.filter((s) => s.from !== s.to);

    // ── .plexmatch safety (episodes only) ──
    // Source tree: a .plexmatch anywhere from the file's dir up to the library
    // root may pin CURRENT filenames (ep: hints) — never rename under one.
    let plexmatchWrite: { dir: string; content: string } | undefined;
    if (discover.kind === 'episode') {
      const rootLocal = plexToLocal(discover.rootPath, pathMap);
      let cursor = localDir;
      let foundSource: string | null = null;
      while (rootLocal && pathKey(cursor).startsWith(pathKey(rootLocal)) && pathKey(cursor) !== pathKey(rootLocal)) {
        if (await fs.stat(`${cursor}/.plexmatch`)) {
          foundSource = `${cursor}/.plexmatch`;
          break;
        }
        const parent = posixDirname(cursor);
        if (parent === cursor) break;
        cursor = parent;
      }
      if (foundSource) {
        record(ineligible(withLocal, 'existing-plexmatch', `source tree has ${foundSource} (may pin current filenames) — never renamed under`));
        continue;
      }

      const pmOp = plan.ops?.find((o): o is Extract<NamingOp, { op: 'write-plexmatch' }> => o.op === 'write-plexmatch');
      if (pmOp) {
        const localShowDir = plexToLocal(pmOp.dir, pathMap);
        const existing = localShowDir ? await fs.readFile(`${localShowDir}/.plexmatch`) : null;
        if (existing === null) {
          plexmatchWrite = { dir: pmOp.dir, content: pmOp.content };
        } else if (existing === pmOp.content) {
          // Already exactly what we'd write (an earlier batch wrote it) — no op needed.
        } else {
          record(
            ineligible(withLocal, 'existing-plexmatch', `target show dir already has a DIFFERENT .plexmatch (${pmOp.dir}) — never clobbered`),
          );
          continue;
        }
      }
    }

    record({
      ...withLocal,
      eligible: true,
      caseOnly: caseOnly || undefined,
      bytes: st.size,
      sidecars,
      plexmatch: plexmatchWrite,
      leftBehind: sidecarPlan.leftBehind,
    });
  }

  if (ctx.selectedRoots() === null) {
    const pruned = pruneSnapshotRows(JOB_NAME, planRows.map((r) => r.itemKey));
    if (pruned > 0) ctx.log(`Pruned ${pruned} stale verify row(s) for keys plan no longer emits.`);
  }

  ctx.log('═══════════════ VERIFY SUMMARY ═══════════════');
  ctx.log(`Verified: ${planRows.length} · eligible for apply: ${eligibleCount}`);
  for (const [reason, n] of [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])) {
    ctx.log(`  ineligible breakdown — ${reason}: ${n}`);
  }
  ctx.log('════════════════════════════════════════════');
  ctx.progress(100, `${eligibleCount}/${planRows.length} eligible`);
}
