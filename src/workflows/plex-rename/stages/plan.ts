import type { JobContext } from '../../../core/types.js';
import { markWorkItem } from '../../../db/store.js';
import { chooseShowHomeRoots, decideRename, finalizePlan, pathKey, type LibraryRoot, type PlanEntry, type RenameInput } from '../naming.js';
import type { DiscoverDetail, PlanDetail } from '../types.js';
import { ledgerSuccessRows } from './ledger.js';

export const JOB_NAME = 'plex-rename-plan';
export const DISCOVER_JOB = 'plex-rename-discover';

/** Injectable seams for tests. */
export interface PlanOverrides {
  readDiscoverRows?: () => { itemKey: string; detail: unknown }[];
  decide?: typeof decideRename;
}

/**
 * Compute each discovered file's canonical-rename decision — PURE Plex-metadata
 * computation via the naming engine, RECOMPUTED every run (plans are derived
 * state; both the metadata and the engine improve over time). Sidecar
 * enumeration and every on-disk check belong to the next stage (verify), which
 * is the only fs-touching read stage — this one never touches the disk, so it
 * passes `siblings: []` and leaves `.plexmatch`-existence to verify.
 */
export async function runPlan(ctx: JobContext, opts: PlanOverrides = {}): Promise<void> {
  const readRows = opts.readDiscoverRows ?? (() => ledgerSuccessRows(DISCOVER_JOB));
  const decide = opts.decide ?? decideRename;

  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log('plex-rename-plan starting — pure metadata computation, recomputed every run, no disk/Plex access.');

  const rows = readRows();
  ctx.log(`Discover snapshots to plan against: ${rows.length}`);
  ctx.progress(5, `${rows.length} snapshot(s)`);

  // Library roots are reconstructed from the snapshots themselves (each carries
  // the Plex-reported root it lives under) — no separate config/env source.
  const roots: LibraryRoot[] = [];
  const seenRoots = new Set<string>();
  for (const row of rows) {
    const d = row.detail as DiscoverDetail;
    if (d?.rootPath && !seenRoots.has(pathKey(d.rootPath))) {
      seenRoots.add(pathKey(d.rootPath));
      roots.push({ path: d.rootPath, kind: d.kind === 'movie' ? 'movie' : 'tv' });
    }
  }
  ctx.log(`Library roots in play: ${roots.map((r) => `${r.path} [${r.kind}]`).join(' · ') || 'none'}`);

  // Every currently-known file path — the "does this target already exist on
  // disk (as far as Plex knows)" set for the plan-level collision pass.
  const existingPaths = new Set<string>();
  for (const row of rows) {
    const d = row.detail as DiscoverDetail;
    if (d?.file) existingPaths.add(pathKey(d.file));
  }

  // One folder per show: pick each show's HOME root (the share already holding
  // the most bytes of it) so a show split across shares consolidates into a
  // single tree — the minority share's files plan a cross-share move.
  const homeRoots = chooseShowHomeRoots(
    rows.map((row) => {
      const d = row.detail as DiscoverDetail;
      return { showRatingKey: d?.show?.ratingKey, rootPath: d?.rootPath, bytes: d?.partSize };
    }),
  );
  const splitShows = new Set<string>();
  for (const row of rows) {
    const d = row.detail as DiscoverDetail;
    const home = d?.show?.ratingKey ? homeRoots.get(d.show.ratingKey) : undefined;
    if (home && d.rootPath && pathKey(home) !== pathKey(d.rootPath)) splitShows.add(d.show!.title);
  }
  if (splitShows.size > 0) {
    ctx.log(`Split shows consolidating to their majority share: ${[...splitShows].join(' · ')}`);
  }

  const entries: PlanEntry[] = [];
  const detailByKey = new Map<string, DiscoverDetail>();
  for (const row of rows) {
    const d = row.detail as DiscoverDetail;
    if (!d?.file) continue;
    if (!ctx.rootAllowed(row.itemKey)) continue;
    detailByKey.set(row.itemKey, d);
    const input: RenameInput = {
      kind: d.kind,
      file: d.file,
      partId: d.partId,
      partSize: d.partSize,
      mediaCount: d.mediaCount,
      partCount: d.partCount,
      partIndex: d.partIndex,
      movie: d.movie,
      show: d.show,
      episodes: d.episodes,
      siblings: [], // sidecars are enumerated from the REAL listing by verify
      roots,
      homeRootPath: d.show?.ratingKey ? homeRoots.get(d.show.ratingKey) : undefined,
    };
    entries.push({ key: row.itemKey, decision: decide(input) });
  }

  const finalized = finalizePlan(entries, existingPaths);

  let renames = 0;
  let canonical = 0;
  let skips = 0;
  const skipReasons = new Map<string, number>();

  finalized.forEach((entry, i) => {
    const d = detailByKey.get(entry.key)!;
    let detail: PlanDetail;
    if (entry.decision.kind === 'rename') {
      renames++;
      const homeRoot = d.show?.ratingKey ? homeRoots.get(d.show.ratingKey) : undefined;
      detail = {
        name: d.name,
        decision: 'rename',
        from: d.file,
        to: entry.decision.targetPath,
        rootPath: d.rootPath,
        targetRootPath: homeRoot ?? d.rootPath,
        ops: entry.decision.ops,
      };
      ctx.log(`  → RENAME "${d.name}"`);
      ctx.log(`      from: ${d.file}`);
      ctx.log(`      to:   ${entry.decision.targetPath}`);
    } else if (entry.decision.kind === 'already-canonical') {
      canonical++;
      detail = { name: d.name, decision: 'already-canonical', from: d.file, to: entry.decision.targetPath };
    } else {
      skips++;
      skipReasons.set(entry.decision.reason, (skipReasons.get(entry.decision.reason) ?? 0) + 1);
      detail = {
        name: d.name,
        decision: 'skip',
        from: d.file,
        reason: entry.decision.reason,
        reasonDetail: entry.decision.detail,
      };
      ctx.log(`  ⊘ skip (${entry.decision.reason}) "${d.name}" — ${entry.decision.detail}`);
    }
    markWorkItem(JOB_NAME, entry.key, 'success', { detail });
    if ((i + 1) % 100 === 0) ctx.progress(10 + Math.round((85 * (i + 1)) / finalized.length), `${i + 1}/${finalized.length} planned`);
  });

  ctx.log('═══════════════ PLAN SUMMARY ═══════════════');
  ctx.log(`Planned: ${finalized.length} · rename: ${renames} · already-canonical: ${canonical} · skip: ${skips}`);
  for (const [reason, n] of [...skipReasons.entries()].sort((a, b) => b[1] - a[1])) {
    ctx.log(`  skip breakdown — ${reason}: ${n}`);
  }
  ctx.log('═════════════════════════════════════════');
  ctx.progress(100, `${renames} rename(s) planned, ${canonical} already canonical, ${skips} skipped`);
}
