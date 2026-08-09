import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { callService } from '../../../core/services.js';
import type { JobContext } from '../../../core/types.js';
import { plexRefreshSection, triggerButlerBackup } from '../../../core/plex-client.js';
import { capStatus, isWorkItemDone, markWorkItem, recordUsage } from '../../../db/store.js';
import { plexRenameConfig } from '../config.js';
import { analyzeJournal, findLatestJournal, JournalWriter, readJournal, type ItemJournalState, type JournalOp } from '../journal.js';
import { mountHealthy, plexToLocal, realWriteFs, shareOf, type WriteFsSeam } from '../lib.js';
import { MoveError, performVerifiedMove, PARTIAL_SUFFIX, type MoveStep } from '../move.js';
import { pathKey, posixDirname } from '../naming.js';
import type { ApplyDetail, DiscoverDetail, PathMapPair, VerifyDetail } from '../types.js';
import { ledgerSuccessRows } from './ledger.js';

export const JOB_NAME = 'plex-rename-apply';
export const VERIFY_JOB = 'plex-rename-verify';
export const DISCOVER_JOB = 'plex-rename-discover';
const MAX_ATTEMPTS = 3;
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
  minAgeDays?: number;
  journalDir?: string;
  reportDir?: string;
  triggerBackup?: typeof triggerButlerBackup;
  refreshSection?: typeof plexRefreshSection;
  cap?: typeof capStatus;
  record?: typeof recordUsage;
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
  const minAgeDays = opts.minAgeDays ?? plexRenameConfig.minAgeDays;
  const journalDir = opts.journalDir ?? plexRenameConfig.journalDir;
  const reportDir = opts.reportDir ?? plexRenameConfig.reportDir;
  const triggerBackup = opts.triggerBackup ?? triggerButlerBackup;
  const refreshSection = opts.refreshSection ?? plexRefreshSection;
  const cap = opts.cap ?? capStatus;
  const record = opts.record ?? recordUsage;
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
  const neededShares = new Map<string, PathMapPair>();
  for (const c of candidates) {
    const share = shareOf(c.verify.from, pathMap);
    if (share) neededShares.set(pathKey(share.plex), share);
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
  const budget = Math.min(quota.dayLeft, candidates.length);
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

  // ── Butler backup once, before the first new mutation ──
  if (batch.length > 0) {
    ctx.log('Triggering Plex Butler DATABASE backup (secondary net — the journal + copy-verify protect the files themselves)…');
    const butler = await callService('plex', () => triggerBackup());
    if (butler.ok) ctx.log('✓ Butler backup triggered');
    else ctx.log(`⚠ Butler backup trigger failed: ${butler.error} — continuing (journal + copy-verify are the primary safety net)`, 'warn');
  }

  const minAgeMs = minAgeDays * 24 * 60 * 60 * 1000;
  const reportPath = resolve(reportDir, `rename-report-${now().toISOString().replace(/[:.]/g, '-')}.md`);

  for (let i = 0; i < batch.length; i++) {
    const { itemKey, verify, discover } = batch[i];
    const say = (msg: string, level?: 'info' | 'warn' | 'error') => ctx.log(`  [${i + 1}/${batch.length}] ${msg}`, level);

    // ── Re-check EVERYTHING at the moment of truth (verify may be a day old) ──
    const softSkip = async (): Promise<string | null> => {
      const st = await fs.stat(verify.localFrom!);
      if (!st || !st.isFile) return `source no longer present: ${verify.localFrom}`;
      if (st.size !== verify.bytes) return `size changed since verify (${st.size} ≠ ${verify.bytes})`;
      if (now().getTime() - st.mtimeMs < minAgeMs) return 'modified again within the still-downloading window';
      if (!verify.caseOnly && (await fs.stat(verify.localTo!))) return `target appeared since verify: ${verify.localTo}`;
      const free = await fs.freeBytes(posixDirname(verify.localTo!));
      if (free !== null && free < st.size + FREE_SPACE_MARGIN) {
        return `insufficient free space for a transient second copy (${free} free < ${st.size} + margin)`;
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
    });
    for (const s of verify.sidecars ?? []) {
      const from = plexToLocal(s.from, pathMap);
      const to = plexToLocal(s.to, pathMap);
      if (from && to) ops.push({ op: 'move', from, to, partial: `${to}${PARTIAL_SUFFIX}`, role: s.role, caseOnly: pathKey(from) === pathKey(to) });
    }
    ops.push({ op: 'rmdir-if-empty', path: posixDirname(verify.localFrom!) });

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
      say(`✓ "${verify.name}" moved + verified (sha256 ${result.mediaSha?.slice(0, 12)}…, ${(verify.sidecars ?? []).length} sidecar(s))`);
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

  ctx.log('═══════════════ APPLY SUMMARY ═══════════════');
  ctx.log(`Applied: ${applied} · soft-skipped: ${skippedAtApply.length} · failed: ${failed} · quota now ${quota.today + applied}/${maxPerDay}`);
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
        const hooks = {
          before: (step: MoveStep) => {
            j.append({ kind: 'op-attempt', at: now().toISOString(), itemKey, opIndex: idx, step });
          },
          after: (step: MoveStep, info?: { sha256?: string; bytes?: number }) => {
            j.append({ kind: 'op-done', at: now().toISOString(), itemKey, opIndex: idx, step, sha256: info?.sha256, bytes: info?.bytes });
          },
        };
        const moved = await performVerifiedMove(fs, { from: op.from, to: op.to, partial: op.partial, expectedBytes: op.bytes, caseOnly: op.caseOnly }, hooks);
        if (op.role === 'media') mediaSha = moved.sha256;
      } else {
        j.append({ kind: 'op-attempt', at: now().toISOString(), itemKey, opIndex: idx });
        if (op.op === 'mkdir') {
          await fs.mkdirp(op.path);
        } else if (op.op === 'write-plexmatch') {
          const current = await fs.readFile(op.path);
          if (current !== null && current !== op.content) throw new Error(`.plexmatch appeared with different content: ${op.path}`);
          if (current === null) await fs.writeFile(op.path, op.content);
        } else if (op.op === 'rmdir-if-empty') {
          const r = await fs.rmdirIfEmpty(op.path);
          ctx.log(`    rmdir-if-empty ${op.path}: ${r}`);
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
