import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { callService } from '../../../core/services.js';
import type { JobContext } from '../../../core/types.js';
import { plexRefreshSection, triggerButlerBackup } from '../../../core/plex-client.js';
import { capStatus, isWorkItemDone, markWorkItem, recordUsage, usageToday } from '../../../db/store.js';
import { plexRenameConfig } from '../config.js';
import { analyzeJournal, findLatestJournal, JournalWriter, readJournal, type ItemJournalState, type JournalOp } from '../journal.js';
import { mountHealthy, plexToLocal, realWriteFs, shareOf, type WriteFsSeam } from '../lib.js';
import { MoveError, performAtomicRenameMove, performVerifiedMove, PARTIAL_SUFFIX, type MoveStep } from '../move.js';
import { pathKey, posixDirname } from '../naming.js';
import type { ApplyDetail, DiscoverDetail, PathMapPair, VerifyDetail } from '../types.js';
import { ledgerSuccessRows } from './ledger.js';

export const JOB_NAME = 'plex-rename-apply';
export const VERIFY_JOB = 'plex-rename-verify';
export const DISCOVER_JOB = 'plex-rename-discover';
const MAX_ATTEMPTS = 3;
/** job_usage meter name tracking Butler DB-backup triggers (once per day). */
const BUTLER_METER = 'plex-rename-butler-backup';
/** Transient headroom the share must have beyond the file's own size (the copy phase doubles it). */
const FREE_SPACE_MARGIN = 1024 * 1024 * 1024;
/** Past this many distinct changed dirs, one full section refresh beats many targeted ones. */
const REFRESH_DIR_CAP = 30;

export interface ApplyOverrides {
  fs?: WriteFsSeam;
  readVerifyRows?: () => { itemKey: string; detail: unknown }[];
  readDiscoverRows?: () => { itemKey: string; detail: unknown }[];
  pathMap?: PathMapPair[];
  applyEnabled?: boolean;
  maxPerDay?: number;
  maxPerRun?: number;
  minAgeDays?: number;
  maxVolumeUtilizationPct?: number;
  journalDir?: string;
  reportDir?: string;
  triggerBackup?: typeof triggerButlerBackup;
  refreshSection?: typeof plexRefreshSection;
  cap?: typeof capStatus;
  record?: typeof recordUsage;
  /** Whether a Butler DB backup was already triggered today (injectable for tests). */
  butlerAlreadyToday?: () => boolean;
  /** Records today's Butler trigger on its own meter (injectable for tests). */
  recordButler?: () => void;
  now?: () => Date;
}

interface Candidate {
  itemKey: string;
  verify: VerifyDetail;
  discover?: DiscoverDetail;
}

/** Parse the shared ledger key back into its halves. */
function parseKey(itemKey: string): { ratingKey: string; partId: number } {
  const idx = itemKey.lastIndexOf('::part');
  return { ratingKey: itemKey.slice(0, idx), partId: Number(itemKey.slice(idx + 6)) };
}

/**
 * The mutating stage — every hard rule from the workflow CLAUDE.md's safety
 * doctrine is enforced HERE, structurally:
 *  - rehearsal mode (PLEX_RENAME_APPLY_ENABLED unset) runs the same selection
 *    and per-item re-checks but journals nothing, marks nothing, mutates
 *    nothing — the report is the only output;
 *  - a missing/unhealthy mount = zero mutations, zero marks, run SUCCESS;
 *  - the daily quota (job_usage meter) is checked up front and every media
 *    file ticks it; sidecars ride along uncounted;
 *  - crash reconciliation runs before any new work: an unresolved journal
 *    item is rolled forward (its intent was durably recorded) or failed loud
 *    — never guessed at;
 *  - every file relocation is performVerifiedMove (copy → checksum-verify →
 *    finalize → delete-original), journaled write-AHEAD per step;
 *  - the ledger success mark happens only after the journal's item-done is
 *    flushed, and each file is applied at most once, EVER (manual unstick to
 *    redo).
 */
export async function runApply(ctx: JobContext, opts: ApplyOverrides = {}): Promise<void> {
  const fs = opts.fs ?? realWriteFs;
  const readVerifyRows = opts.readVerifyRows ?? (() => ledgerSuccessRows(VERIFY_JOB));
  const readDiscoverRows = opts.readDiscoverRows ?? (() => ledgerSuccessRows(DISCOVER_JOB));
  const pathMap = opts.pathMap ?? plexRenameConfig.pathMap;
  const applyEnabled = opts.applyEnabled ?? plexRenameConfig.applyEnabled;
  const maxPerDay = opts.maxPerDay ?? plexRenameConfig.maxPerDay;
  const maxPerRun = opts.maxPerRun ?? plexRenameConfig.maxPerRun;
  const minAgeDays = opts.minAgeDays ?? plexRenameConfig.minAgeDays;
  const maxVolumePct = opts.maxVolumeUtilizationPct ?? plexRenameConfig.maxVolumeUtilizationPct;
  const journalDir = opts.journalDir ?? plexRenameConfig.journalDir;
  const reportDir = opts.reportDir ?? plexRenameConfig.reportDir;
  const triggerBackup = opts.triggerBackup ?? triggerButlerBackup;
  const refreshSection = opts.refreshSection ?? plexRefreshSection;
  const cap = opts.cap ?? capStatus;
  const record = opts.record ?? recordUsage;
  const butlerAlreadyToday = opts.butlerAlreadyToday ?? (() => usageToday(BUTLER_METER) > 0);
  const recordButler = opts.recordButler ?? (() => recordUsage(BUTLER_METER));
  const now = opts.now ?? (() => new Date());

  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log(
    applyEnabled
      ? 'plex-rename-apply starting — APPLY ENABLED. Copy → checksum-verify → delete-original per file, write-ahead journaled.'
      : 'plex-rename-apply starting — REHEARSAL MODE (PLEX_RENAME_APPLY_ENABLED unset/0). Nothing will be journaled, marked, or mutated.',
  );

  // ── Selection ──
  const discoverByKey = new Map(readDiscoverRows().map((r) => [r.itemKey, r.detail as DiscoverDetail]));
  const candidates: Candidate[] = [];
  for (const row of readVerifyRows()) {
    const verify = row.detail as VerifyDetail;
    if (!verify?.eligible) continue;
    if (!ctx.rootAllowed(row.itemKey)) continue;
    if (isWorkItemDone(JOB_NAME, row.itemKey, MAX_ATTEMPTS)) continue; // applied once, ever
    candidates.push({ itemKey: row.itemKey, verify, discover: discoverByKey.get(row.itemKey) });
  }
  candidates.sort((a, b) => (a.itemKey < b.itemKey ? -1 : a.itemKey > b.itemKey ? 1 : 0));
  ctx.log(`Eligible, not-yet-applied candidates: ${candidates.length}`);

  // ── Hard mount preflight: ALL shares referenced by any candidate must be healthy ──
  // Both sides: a consolidating (cross-share) move reads from one share and
  // writes to another, so the TARGET's share is just as load-bearing.
  const neededShares = new Map<string, PathMapPair>();
  for (const c of candidates) {
    for (const p of [c.verify.from, c.verify.to]) {
      const share = shareOf(p, pathMap);
      if (share) neededShares.set(pathKey(share.plex), share);
    }
  }
  for (const share of neededShares.values()) {
    if (!(await mountHealthy(share.local, fs))) {
      ctx.log(`✗ mount MISSING/unhealthy: ${share.local} — performing ZERO mutations this run (routine skip, nothing marked).`, 'warn');
      ctx.progress(100, 'mount missing — skipped cleanly');
      return;
    }
  }

  // ── Daily quota ──
  const quota = cap(JOB_NAME, maxPerDay, maxPerDay * 30);
  ctx.log(`Daily quota: ${quota.today}/${maxPerDay} used today (${quota.dayLeft} left) · month ${quota.month}/${maxPerDay * 30}`);
  const budget = Math.min(quota.dayLeft, maxPerRun > 0 ? maxPerRun : Number.MAX_SAFE_INTEGER, candidates.length);
  if (maxPerRun > 0) ctx.log(`Per-run batch cap: ${maxPerRun} (budget this run: ${budget})`);
  const batch = candidates.slice(0, budget);
  if (candidates.length > 0 && budget === 0) {
    ctx.log(`Daily quota exhausted (${quota.reason}) — stopping gracefully; the next run resumes.`);
    ctx.progress(100, 'daily quota exhausted');
    return;
  }

  // ── Rehearsal mode: report and stop ──
  if (!applyEnabled) {
    rehearse(ctx, batch, candidates.length, reportDir, now());
    return;
  }

  // ── Narrate the FULL batch manifest before touching anything — the log
  // alone must say exactly what this run intends to do, item by item. ──
  ctx.log(`━━━ BATCH MANIFEST — ${batch.length} item(s) selected (of ${candidates.length} eligible, budget ${budget}) ━━━`);
  batch.forEach(({ verify }, i) => {
    const fromShare0 = shareOf(verify.from, pathMap);
    const toShare0 = shareOf(verify.to, pathMap);
    const same0 = !!fromShare0 && !!toShare0 && fromShare0.plex === toShare0.plex;
    const strat = same0 && !verify.caseOnly ? 'RENAME (same share, instant)' : 'COPY+VERIFY (cross-share or case-only)';
    ctx.log(`  ${String(i + 1).padStart(3)}. "${verify.name}" — ${strat}, ${verify.bytes ?? '?'} bytes, ${(verify.sidecars ?? []).length} sidecar(s)${verify.plexmatch ? ', writes .plexmatch' : ''}`);
    ctx.log(`       ${verify.from}`);
    ctx.log(`       → ${verify.to}`);
  });
  ctx.log('━━━ END MANIFEST — beginning execution ━━━');

  // ── Crash reconciliation (before ANY new work, before Butler) ──
  let journal: JournalWriter | null = null;
  const openJournal = () => {
    if (!journal) {
      journal = new JournalWriter(journalDir, now());
      journal.append({
        kind: 'run-start',
        at: now().toISOString(),
        applyEnabled: true,
        dailyCap: maxPerDay,
        pathMap: pathMap.map((p) => ({ plex: p.plex, local: p.local })),
        mountsChecked: Object.fromEntries([...neededShares.values()].map((s) => [s.plex, true])),
      });
    }
    return journal;
  };

  let failed = 0;
  let applied = 0;
  const appliedRows: ApplyDetail[] = [];
  const skippedAtApply: { name: string; reason: string }[] = [];
  const changedPlexDirs = new Map<string, 'movie' | 'episode'>();

  const latest = findLatestJournal(journalDir);
  if (latest) {
    const analysis = analyzeJournal(readJournal(latest));
    if (analysis.unresolved.length > 0) {
      ctx.log(`⚠ previous journal ${latest} has ${analysis.unresolved.length} unresolved item(s) — reconciling against disk BEFORE any new work.`, 'warn');
      for (const item of analysis.unresolved) {
        const outcome = await reconcileItem(ctx, item, fs, openJournal(), now);
        if (outcome === 'completed') {
          applied++;
          record(JOB_NAME);
          const { ratingKey } = parseKey(item.itemKey);
          void ratingKey;
        } else if (outcome === 'failed') {
          failed++;
        }
        // 'abandoned' items simply flow through this run's normal selection again.
      }
    }
  }

  // ── Butler backup at most ONCE PER DAY, before the day's first mutation ──
  // Right-sized for batch-driven operation (2026-08-11): backing up the large
  // live Plex DB before EVERY batch — five in one day — contributed to a real
  // NAS saturation incident (Plex's DB-backed API hung, clients showed the
  // server unavailable). One backup per day is the same protection: it
  // snapshots the DB before the day's mutations begin.
  if (batch.length > 0) {
    if (butlerAlreadyToday()) {
      ctx.log('Plex Butler DB backup already triggered today — not re-triggering (once per day; journal + copy-verify are the primary net).');
    } else {
      ctx.log('Triggering Plex Butler DATABASE backup (secondary net — the journal + copy-verify protect the files themselves)…');
      const butler = await callService('plex', () => triggerBackup());
      if (butler.ok) {
        recordButler();
        ctx.log('✓ Butler backup triggered');
      } else {
        ctx.log(`⚠ Butler backup trigger failed: ${butler.error} — continuing (journal + copy-verify are the primary safety net)`, 'warn');
      }
    }
  }

  const minAgeMs = minAgeDays * 24 * 60 * 60 * 1000;
  const reportPath = resolve(reportDir, `rename-report-${now().toISOString().replace(/[:.]/g, '-')}.md`);

  for (let i = 0; i < batch.length; i++) {
    const { itemKey, verify, discover } = batch[i];
    const say = (msg: string, level?: 'info' | 'warn' | 'error') => ctx.log(`  [${i + 1}/${batch.length}] ${msg}`, level);

    // ── Move strategy: same-share (and not case-only) = atomic rename — the
    // bytes are never rewritten, so there is nothing to copy, verify, or run
    // out of space for. Cross-share physically requires copying and keeps the
    // full copy → checksum-verify → delete procedure.
    const fromShare = shareOf(verify.from, pathMap);
    const toShare = shareOf(verify.to, pathMap);
    const sameShare = !!fromShare && !!toShare && fromShare.plex === toShare.plex;
    const strategy: 'rename' | 'copy-verify' = sameShare && !verify.caseOnly ? 'rename' : 'copy-verify';

    // ── Re-check EVERYTHING at the moment of truth (verify may be a day old) ──
    const softSkip = async (): Promise<string | null> => {
      const st = await fs.stat(verify.localFrom!);
      if (!st || !st.isFile) return `source no longer present: ${verify.localFrom}`;
      if (st.size !== verify.bytes) return `size changed since verify (${st.size} ≠ ${verify.bytes})`;
      if (now().getTime() - st.mtimeMs < minAgeMs) return 'modified again within the still-downloading window';
      if (!verify.caseOnly && (await fs.stat(verify.localTo!))) return `target appeared since verify: ${verify.localTo}`;
      if (strategy === 'copy-verify') {
        // Space checks only matter when bytes are actually copied — an atomic
        // rename consumes no space and cannot change volume utilization.
        const usage = await fs.volumeUsage(posixDirname(verify.localTo!));
        if (usage) {
          if (usage.free < st.size + FREE_SPACE_MARGIN) {
            return `insufficient free space for a transient second copy (${usage.free} free < ${st.size} + margin)`;
          }
          // Volume-overburden guard (owner rule): the target volume's projected
          // utilization AFTER this copy lands must stay at or under the cap —
          // moves to an overfull volume halt (soft-skip) rather than fill it.
          if (usage.total > 0) {
            const projectedPct = ((usage.total - usage.free + st.size) / usage.total) * 100;
            if (projectedPct > maxVolumePct) {
              return `target volume would reach ${projectedPct.toFixed(1)}% utilization (cap ${maxVolumePct}%) — halting moves onto it`;
            }
          }
        }
      }
      for (const s of verify.sidecars ?? []) {
        const localTo = plexToLocal(s.to, pathMap);
        if (localTo && (await fs.stat(localTo))) return `sidecar target appeared since verify: ${s.to}`;
      }
      return null;
    };
    const skipReason = await softSkip();
    if (skipReason) {
      say(`⊘ soft-skip "${verify.name}" — ${skipReason} (recomputed next run)`, 'warn');
      skippedAtApply.push({ name: verify.name, reason: skipReason });
      markWorkItem(JOB_NAME, itemKey, 'skipped', { detail: { name: `${verify.name} — skipped at apply`, reason: skipReason } });
      continue;
    }

    // ── Build the op list (local paths; fixed order) ──
    const ops: JournalOp[] = [{ op: 'mkdir', path: posixDirname(verify.localTo!) }];
    if (verify.plexmatch) {
      const localPmDir = plexToLocal(verify.plexmatch.dir, pathMap);
      if (localPmDir) {
        const prior = await fs.readFile(`${localPmDir}/.plexmatch`);
        if (prior !== null && prior !== verify.plexmatch.content) {
          say(`⊘ soft-skip "${verify.name}" — a DIFFERENT .plexmatch appeared at ${localPmDir} since verify`, 'warn');
          markWorkItem(JOB_NAME, itemKey, 'skipped', { detail: { name: `${verify.name} — skipped at apply`, reason: 'plexmatch-appeared' } });
          continue;
        }
        if (prior === null) {
          ops.push({ op: 'write-plexmatch', path: `${localPmDir}/.plexmatch`, content: verify.plexmatch.content, priorContent: null });
        }
      }
    }
    ops.push({
      op: 'move',
      from: verify.localFrom!,
      to: verify.localTo!,
      partial: `${verify.localTo}${PARTIAL_SUFFIX}`,
      role: 'media',
      bytes: verify.bytes,
      caseOnly: verify.caseOnly,
      strategy,
    });
    for (const s of verify.sidecars ?? []) {
      const from = plexToLocal(s.from, pathMap);
      const to = plexToLocal(s.to, pathMap);
      if (!from || !to) continue;
      const scCaseOnly = pathKey(from) === pathKey(to);
      ops.push({
        op: 'move',
        from,
        to,
        partial: `${to}${PARTIAL_SUFFIX}`,
        role: s.role,
        caseOnly: scCaseOnly,
        strategy: sameShare && !scCaseOnly ? 'rename' : 'copy-verify',
      });
    }
    // The stop boundary for empty-ancestor cleanup: the file's own library
    // root, mapped local — nested release wrappers (Show S01-S04/Season X/…)
    // would otherwise leave empty husk chains behind once drained.
    const localLibraryRoot = discover?.rootPath ? plexToLocal(discover.rootPath, pathMap) : null;
    ops.push({
      op: 'rmdir-if-empty',
      path: posixDirname(verify.localFrom!),
      stopRoot: localLibraryRoot ?? shareOf(verify.from, pathMap)?.local ?? undefined,
    });

    // ── Journal the full intent, then execute op by op ──
    const j = openJournal();
    const { ratingKey, partId } = parseKey(itemKey);
    j.append({ kind: 'item-planned', at: now().toISOString(), itemKey, ratingKey, partId, title: verify.name, from: verify.from, to: verify.to, ops });

    const result = await executeOps(ctx, j, itemKey, ops, fs, now, 0);
    if (result.ok) {
      j.append({ kind: 'item-done', at: now().toISOString(), itemKey });
      const detail: ApplyDetail = {
        name: verify.name,
        from: verify.from,
        to: verify.to,
        sha256: result.mediaSha ?? '',
        bytes: verify.bytes ?? 0,
        sidecarCount: (verify.sidecars ?? []).length,
        appliedAt: now().toISOString(),
        markdown: reportPath,
      };
      markWorkItem(JOB_NAME, itemKey, 'success', { detail });
      record(JOB_NAME);
      applied++;
      appliedRows.push(detail);
      changedPlexDirs.set(posixDirname(verify.from), discover?.kind ?? 'movie');
      changedPlexDirs.set(posixDirname(verify.to), discover?.kind ?? 'movie');
      say(
        result.mediaSha
          ? `✓ "${verify.name}" copied + verified + original deleted (sha256 ${result.mediaSha.slice(0, 12)}…, ${(verify.sidecars ?? []).length} sidecar(s))`
          : `✓ "${verify.name}" renamed atomically (same share — bytes untouched, ${(verify.sidecars ?? []).length} sidecar(s))`,
      );
    } else {
      j.append({ kind: 'item-aborted', at: now().toISOString(), itemKey, error: result.error!, completedOps: result.completedOps });
      markWorkItem(JOB_NAME, itemKey, 'failed', { detail: { name: `${verify.name} — apply failed`, error: result.error } });
      failed++;
      say(`✗ "${verify.name}" — ${result.error} (original untouched unless the log above says otherwise; journal has the full record)`, 'error');
    }
    ctx.progress(Math.round((90 * (i + 1)) / batch.length), `${i + 1}/${batch.length} processed`);
  }

  // ── Report ──
  writeReport(reportPath, {
    rehearsal: false,
    generatedAt: now().toISOString(),
    applied: appliedRows,
    skipped: skippedAtApply,
    failedCount: failed,
    journalPath: journal ? (journal as JournalWriter).path : null,
    leftoverDirs: batch.flatMap((b) => b.verify.leftBehind ?? []),
  });
  ctx.log(`Report written: ${reportPath}`);

  // ── Targeted Plex refresh ──
  if (changedPlexDirs.size > 0) {
    const dirs = [...changedPlexDirs.entries()];
    try {
      if (dirs.length > REFRESH_DIR_CAP) {
        ctx.log(`Refreshing both sections in full (${dirs.length} changed dirs > ${REFRESH_DIR_CAP})…`);
        await callService('plex', () => refreshSection(plexRenameConfig.movieSection));
        await callService('plex', () => refreshSection(plexRenameConfig.tvSection));
      } else {
        for (const [dir, kind] of dirs) {
          const section = kind === 'movie' ? plexRenameConfig.movieSection : plexRenameConfig.tvSection;
          ctx.log(`Refreshing section ${section} at ${dir}`);
          await callService('plex', () => refreshSection(section, dir));
        }
      }
    } catch (err) {
      ctx.log(`⚠ Plex refresh failed: ${err instanceof Error ? err.message : err} — recoverable; Plex's next scheduled scan picks it up`, 'warn');
    }
  }

  if (journal) {
    (journal as JournalWriter).append({ kind: 'run-end', at: now().toISOString(), attempted: batch.length, applied, failed });
    (journal as JournalWriter).close();
  }

  const renamedCount = appliedRows.filter((r) => !r.sha256).length;
  const copiedRows = appliedRows.filter((r) => r.sha256);
  const copiedGb = copiedRows.reduce((sum, r) => sum + (r.bytes ?? 0), 0) / 1e9;
  ctx.log('═══════════════ APPLY SUMMARY ═══════════════');
  ctx.log(`Applied: ${applied} (${renamedCount} atomic rename(s), ${copiedRows.length} verified cross-share cop(ies) totalling ${copiedGb.toFixed(2)} GB)`);
  ctx.log(`Soft-skipped: ${skippedAtApply.length} · failed: ${failed} · quota now ${quota.today + applied}/${maxPerDay}`);
  ctx.log(`Plex directories refreshed: ${changedPlexDirs.size} · journal: ${journal ? (journal as JournalWriter).path : 'none (no mutations)'}`);
  ctx.log('═══════════════════════════════════════════');
  ctx.progress(100, `${applied} applied, ${failed} failed`);
  if (failed > 0) {
    throw new Error(`${failed} item(s) failed to apply this run — see logs + journal`);
  }
}

/** Execute an item's ops in order with write-ahead journaling; returns per-item outcome. */
async function executeOps(
  ctx: JobContext,
  j: JournalWriter,
  itemKey: string,
  ops: JournalOp[],
  fs: WriteFsSeam,
  now: () => Date,
  startAt: number,
): Promise<{ ok: boolean; error?: string; completedOps: number; mediaSha?: string }> {
  let mediaSha: string | undefined;
  for (let idx = startAt; idx < ops.length; idx++) {
    const op = ops[idx];
    try {
      if (op.op === 'move') {
        // Narrate every journaled step of every move — the log alone should
        // reconstruct exactly what happened to each file, in order.
        const hooks = {
          before: (step: MoveStep) => {
            j.append({ kind: 'op-attempt', at: now().toISOString(), itemKey, opIndex: idx, step });
            ctx.log(`    ${op.role}[${op.strategy ?? 'copy-verify'}] ${step}… ${step === 'copy' ? `${op.from} → ${op.partial}` : step === 'finalize' && op.strategy === 'rename' ? `${op.from} → ${op.to}` : op.to}`);
          },
          after: (step: MoveStep, info?: { sha256?: string; bytes?: number }) => {
            j.append({ kind: 'op-done', at: now().toISOString(), itemKey, opIndex: idx, step, sha256: info?.sha256, bytes: info?.bytes });
            ctx.log(`    ${op.role} ${step} ✓${info?.bytes !== undefined ? ` (${info.bytes} bytes)` : ''}${info?.sha256 ? ` sha256=${info.sha256}` : ''}`);
          },
        };
        if (op.strategy === 'rename') {
          await performAtomicRenameMove(fs, { from: op.from, to: op.to, expectedBytes: op.bytes }, hooks);
          // No hash: the bytes were never read or rewritten — nothing to verify.
        } else {
          const moved = await performVerifiedMove(fs, { from: op.from, to: op.to, partial: op.partial, expectedBytes: op.bytes, caseOnly: op.caseOnly }, hooks);
          if (op.role === 'media') mediaSha = moved.sha256;
        }
      } else {
        j.append({ kind: 'op-attempt', at: now().toISOString(), itemKey, opIndex: idx });
        if (op.op === 'mkdir') {
          ctx.log(`    mkdir -p ${op.path}`);
          await fs.mkdirp(op.path);
        } else if (op.op === 'write-plexmatch') {
          const current = await fs.readFile(op.path);
          if (current !== null && current !== op.content) throw new Error(`.plexmatch appeared with different content: ${op.path}`);
          if (current === null) {
            ctx.log(`    writing .plexmatch → ${op.path} (${op.content.split('\n').filter(Boolean).length} identity line(s))`);
            await fs.writeFile(op.path, op.content);
          } else {
            ctx.log(`    .plexmatch already present with identical content — not rewritten: ${op.path}`);
          }
        } else if (op.op === 'rmdir-if-empty') {
          const r = await fs.rmdirIfEmpty(op.path);
          ctx.log(`    rmdir-if-empty ${op.path}: ${r}`);
          // Climb the now-empty ANCESTOR chain (nested release wrappers become
          // husks otherwise — found live: "Mr Robot S01-S04 …/Mr.Robot.S02…"
          // left its outer wrapper behind once drained). Plain rmdir only —
          // structurally incapable of deleting files — and strictly below the
          // library-root boundary; the first non-empty ancestor stops the climb.
          if (r === 'removed' && op.stopRoot) {
            const rootKey = pathKey(op.stopRoot.replace(/\/+$/, ''));
            let cursor = posixDirname(op.path);
            while (pathKey(cursor).startsWith(`${rootKey}/`)) {
              const rc = await fs.rmdirIfEmpty(cursor);
              ctx.log(`    rmdir-if-empty (empty ancestor) ${cursor}: ${rc}`);
              if (rc !== 'removed') break;
              cursor = posixDirname(cursor);
            }
          }
        }
        j.append({ kind: 'op-done', at: now().toISOString(), itemKey, opIndex: idx });
      }
    } catch (err) {
      const step = err instanceof MoveError ? err.step : undefined;
      const error = err instanceof Error ? err.message : String(err);
      j.append({ kind: 'op-failed', at: now().toISOString(), itemKey, opIndex: idx, step: step === 'preflight' ? undefined : step, error });
      return { ok: false, error, completedOps: idx, mediaSha };
    }
  }
  return { ok: true, completedOps: ops.length, mediaSha };
}

/**
 * Reconcile ONE unresolved journal item against the actual disk. Roll forward
 * when the durable intent already (verifiably) happened; abandon back to the
 * normal pipeline when nothing irreversible happened; fail LOUD on ambiguity.
 */
async function reconcileItem(
  ctx: JobContext,
  item: ItemJournalState,
  fs: WriteFsSeam,
  j: JournalWriter,
  now: () => Date,
): Promise<'completed' | 'failed' | 'abandoned'> {
  const ops = item.planned.ops;
  const mediaIdx = ops.findIndex((o) => o.op === 'move' && o.role === 'media');
  const media = mediaIdx >= 0 ? (ops[mediaIdx] as Extract<JournalOp, { op: 'move' }>) : null;
  const say = (m: string, level?: 'info' | 'warn' | 'error') => ctx.log(`  [reconcile] ${m}`, level);

  if (!media) {
    say(`"${item.planned.title}" — no media move journaled; abandoning to normal reprocessing.`);
    return 'abandoned';
  }
  const fromSt = await fs.stat(media.from);
  const toSt = await fs.stat(media.to);
  const partialSt = await fs.stat(media.partial);

  // Nothing irreversible happened → clean the debris, let the pipeline redo it.
  if (fromSt && !toSt) {
    if (partialSt) {
      await fs.unlink(media.partial);
      say(`"${item.planned.title}" — deleted unverified partial debris; item reprocesses normally.`);
    } else {
      say(`"${item.planned.title}" — move never happened; item reprocesses normally.`);
    }
    return 'abandoned';
  }

  // Both exist (crash between finalize and delete-source) → verify before rolling forward.
  if (fromSt && toSt) {
    const [hFrom, hTo] = [await fs.hashFile(media.from), await fs.hashFile(media.to)];
    if (!hFrom || !hTo || hFrom.sha256 !== hTo.sha256) {
      say(`"${item.planned.title}" — source AND target exist with DIFFERENT content; failing loud for manual review.`, 'error');
      markWorkItem(JOB_NAME, item.itemKey, 'failed', { detail: { name: `${item.planned.title} — reconcile ambiguous`, error: 'source and target diverge' } });
      return 'failed';
    }
    say(`"${item.planned.title}" — verified duplicate from a crash window; deleting the SOURCE and rolling forward.`);
    j.append({ kind: 'item-planned', at: now().toISOString(), itemKey: item.itemKey, ratingKey: item.planned.ratingKey, partId: item.planned.partId, title: `${item.planned.title} (reconciled)`, from: item.planned.from, to: item.planned.to, ops });
    j.append({ kind: 'op-attempt', at: now().toISOString(), itemKey: item.itemKey, opIndex: mediaIdx, step: 'delete-source' });
    await fs.unlink(media.from);
    j.append({ kind: 'op-done', at: now().toISOString(), itemKey: item.itemKey, opIndex: mediaIdx, step: 'delete-source' });
    return finishRemaining(ctx, item, mediaIdx, ops, fs, j, now);
  }

  // Media fully moved → roll the remaining ops forward.
  if (!fromSt && toSt) {
    say(`"${item.planned.title}" — media already at target; rolling the remaining ops forward.`);
    j.append({ kind: 'item-planned', at: now().toISOString(), itemKey: item.itemKey, ratingKey: item.planned.ratingKey, partId: item.planned.partId, title: `${item.planned.title} (reconciled)`, from: item.planned.from, to: item.planned.to, ops });
    return finishRemaining(ctx, item, mediaIdx, ops, fs, j, now);
  }

  say(`"${item.planned.title}" — file at NEITHER side; failing loud for manual review.`, 'error');
  markWorkItem(JOB_NAME, item.itemKey, 'failed', { detail: { name: `${item.planned.title} — reconcile ambiguous`, error: 'file at neither source nor target' } });
  return 'failed';
}

/** Roll forward everything after the media move (sidecars/rmdir), then complete the item. */
async function finishRemaining(
  ctx: JobContext,
  item: ItemJournalState,
  mediaIdx: number,
  ops: JournalOp[],
  fs: WriteFsSeam,
  j: JournalWriter,
  now: () => Date,
): Promise<'completed' | 'failed'> {
  // Re-execute every op after the media move, tolerating already-done state:
  // a sidecar already at its target is skipped; a stranded sidecar partial is
  // deleted and the move redone fresh.
  for (let idx = mediaIdx + 1; idx < ops.length; idx++) {
    const op = ops[idx];
    if (op.op === 'move') {
      const [fromSt, toSt, partialSt] = [await fs.stat(op.from), await fs.stat(op.to), await fs.stat(op.partial)];
      if (partialSt) await fs.unlink(op.partial);
      if (toSt && !fromSt) continue; // already done
      if (toSt && fromSt) {
        const [hF, hT] = [await fs.hashFile(op.from), await fs.hashFile(op.to)];
        if (hF && hT && hF.sha256 === hT.sha256) {
          await fs.unlink(op.from);
          continue;
        }
        markWorkItem(JOB_NAME, item.itemKey, 'failed', { detail: { name: `${item.planned.title} — reconcile ambiguous`, error: `sidecar diverges: ${op.to}` } });
        return 'failed';
      }
      if (!fromSt && !toSt) continue; // sidecar vanished — the media is what matters; report-only concern
    }
  }
  const result = await executeOps(ctx, j, item.itemKey, ops, fs, now, mediaIdx + 1);
  if (!result.ok) {
    j.append({ kind: 'item-aborted', at: now().toISOString(), itemKey: item.itemKey, error: result.error!, completedOps: result.completedOps });
    markWorkItem(JOB_NAME, item.itemKey, 'failed', { detail: { name: `${item.planned.title} — reconcile roll-forward failed`, error: result.error } });
    return 'failed';
  }
  j.append({ kind: 'item-done', at: now().toISOString(), itemKey: item.itemKey });
  const detail: ApplyDetail = {
    name: `${item.planned.title} (reconciled)`,
    from: item.planned.from,
    to: item.planned.to,
    sha256: '',
    bytes: 0,
    sidecarCount: 0,
    appliedAt: now().toISOString(),
  };
  markWorkItem(JOB_NAME, item.itemKey, 'success', { detail });
  return 'completed';
}

/** Rehearsal: log the exact would-run ops + write the REPORT-ONLY markdown. Nothing else. */
function rehearse(ctx: JobContext, batch: Candidate[], totalCandidates: number, reportDir: string, at: Date): void {
  ctx.log(`Rehearsal: ${batch.length} item(s) within today's quota (${totalCandidates} total eligible).`);
  for (const { verify } of batch) {
    ctx.log(`  WOULD move "${verify.name}"`);
    ctx.log(`    from: ${verify.localFrom}`);
    ctx.log(`    to:   ${verify.localTo}`);
    for (const s of verify.sidecars ?? []) ctx.log(`    with sidecar: ${s.from} → ${s.to}`);
    if (verify.plexmatch) ctx.log(`    would write .plexmatch in ${verify.plexmatch.dir}`);
  }
  const reportPath = resolve(reportDir, `rename-report-${at.toISOString().replace(/[:.]/g, '-')}.md`);
  writeReport(reportPath, {
    rehearsal: true,
    generatedAt: at.toISOString(),
    applied: batch.map((b) => ({
      name: b.verify.name,
      from: b.verify.from,
      to: b.verify.to,
      sha256: '',
      bytes: b.verify.bytes ?? 0,
      sidecarCount: (b.verify.sidecars ?? []).length,
      appliedAt: '',
    })),
    skipped: [],
    failedCount: 0,
    journalPath: null,
    leftoverDirs: batch.flatMap((b) => b.verify.leftBehind ?? []),
  });
  ctx.log(`REPORT-ONLY rehearsal report written: ${reportPath}`);
  ctx.progress(100, `rehearsal — ${batch.length} would-move item(s), nothing touched`);
}

interface ReportData {
  rehearsal: boolean;
  generatedAt: string;
  applied: ApplyDetail[];
  skipped: { name: string; reason: string }[];
  failedCount: number;
  journalPath: string | null;
  leftoverDirs: string[];
}

function writeReport(path: string, data: ReportData): void {
  mkdirSync(resolve(path, '..'), { recursive: true });
  const lines: string[] = [
    `# plex-rename ${data.rehearsal ? 'REPORT-ONLY rehearsal' : 'apply report'}`,
    '',
    `Generated: ${data.generatedAt}`,
    data.journalPath ? `Write-ahead journal: \`${data.journalPath}\`` : '_No journal written (no real mutations)._',
    '',
    `## ${data.rehearsal ? 'Would move' : 'Moved'} (${data.applied.length})`,
    '',
  ];
  for (const a of data.applied) {
    lines.push(`- **${a.name}**${a.sidecarCount ? ` (+${a.sidecarCount} sidecar(s))` : ''}`);
    lines.push(`  - from: \`${a.from}\``);
    lines.push(`  - to: \`${a.to}\``);
    if (a.sha256) lines.push(`  - sha256: \`${a.sha256}\``);
  }
  if (data.skipped.length > 0) {
    lines.push('', `## Soft-skipped at apply time (${data.skipped.length})`, '');
    for (const s of data.skipped) lines.push(`- ${s.name} — ${s.reason}`);
  }
  if (data.failedCount > 0) {
    lines.push('', `## Failed: ${data.failedCount} — see the run logs and journal; originals untouched per the move procedure.`);
  }
  const leftovers = [...new Set(data.leftoverDirs)];
  if (leftovers.length > 0) {
    lines.push('', `## Left behind in source folders (${leftovers.length}) — manual cleanup, never automatic`, '');
    for (const l of leftovers.slice(0, 200)) lines.push(`- \`${l}\``);
    if (leftovers.length > 200) lines.push(`- … and ${leftovers.length - 200} more`);
  }
  writeFileSync(path, `${lines.join('\n')}\n`);
}
