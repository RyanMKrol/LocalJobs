// Manual, NEVER-scheduled recovery tool for plex-rename-apply. Reads the most
// recent write-ahead journal (or one passed by path) and reverses every
// completed operation, item by item in reverse order — moves are reversed with
// the SAME copy → checksum-verify → delete procedure they were applied with,
// so even the undo can never lose bytes.
//
// Defaults to a DRY RUN (prints what it WOULD revert, touches nothing). Pass
// --apply to actually execute the reverts.
//
// Usage:
//   tsx scripts/plex-rename-undo.ts [--apply] [path/to/rename-journal-*.ndjson]
//
// With no path given, it picks the most recent
// src/workflows/plex-rename/data/out/journal/rename-journal-*.ndjson file.
//
// Semantics per completed op (reverse order within each item):
//   move   — fully done → verified move back (to → from), recreating the
//            original parent dir first. `from` now occupied → conflict, never
//            overwritten. Finalized-but-source-still-present (crash window) →
//            hashes compared: equal → the COPY is deleted; different → conflict.
//            A stranded partial is deleted (it was never verified).
//   write-plexmatch — current content identical to what we wrote → restore the
//            recorded prior content (or delete when there was none); content
//            differs (hand-edited since) → conflict, never clobbered.
//   mkdir  — rmdir ONLY if empty (structurally incapable of deleting files).
//   rmdir-if-empty — nothing to do (the reverse move's mkdirp already
//            recreated the original dir if it was removed).
//
// The apply ledger is deliberately left alone: undo is a disaster tool; if the
// operator wants an undone item reprocessed they unstick its apply row from
// the dashboard, same doctrine as plex-language-undo.
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { realWriteFs, type WriteFsSeam } from '../src/workflows/plex-rename/lib.js';
import { analyzeJournal, findLatestJournal, readJournal, type ItemJournalState, type JournalOp, type JournalRecord } from '../src/workflows/plex-rename/journal.js';
import { performVerifiedMove, MoveError, PARTIAL_SUFFIX } from '../src/workflows/plex-rename/move.js';
import { posixDirname } from '../src/workflows/plex-rename/naming.js';

const here = dirname(fileURLToPath(import.meta.url));
const defaultJournalDir = resolve(here, '..', 'src', 'workflows', 'plex-rename', 'data', 'out', 'journal');

export interface UndoOpResult {
  itemKey: string;
  op: JournalOp['op'];
  path: string;
  outcome: 'reverted' | 'conflict' | 'already-reverted' | 'failed' | 'dry-run' | 'nothing-to-do';
  detail?: string;
}

/**
 * Compute (and, if `apply`, execute) the reversal of every completed op in a
 * journal. Pure over the injected fs seam — hermetically testable; the real
 * seam routes through callService('fs', ...).
 */
export async function runUndo(
  records: JournalRecord[],
  opts: { apply: boolean; fs?: WriteFsSeam; log?: (msg: string) => void },
): Promise<UndoOpResult[]> {
  const fs = opts.fs ?? realWriteFs;
  const say = opts.log ?? console.log;
  const analysis = analyzeJournal(records);
  const results: UndoOpResult[] = [];

  // Mount preflight: every local root the journal recorded as checked must
  // still be reachable — an unmounted share must read as "refuse", never as
  // "already reverted".
  const runStart = records.find((r): r is Extract<JournalRecord, { kind: 'run-start' }> => r.kind === 'run-start');
  for (const pair of runStart?.pathMap ?? []) {
    const st = await fs.stat(pair.local);
    if (!st || !st.isDirectory) {
      say(`✗ mount missing/unhealthy: ${pair.local} — refusing to ${opts.apply ? 'revert' : 'analyze reverts'} against an absent share.`);
      results.push({ itemKey: '(preflight)', op: 'mkdir', path: pair.local, outcome: 'failed', detail: 'mount missing' });
      return results;
    }
  }

  const itemsNewestFirst = [...analysis.items].reverse();
  say(`${analysis.items.length} journaled item(s); reversing completed operations (newest item first).`);

  for (const item of itemsNewestFirst) {
    results.push(...(await undoItem(item, fs, opts.apply, say)));
  }
  return results;
}

async function undoItem(
  item: ItemJournalState,
  fs: WriteFsSeam,
  apply: boolean,
  say: (msg: string) => void,
): Promise<UndoOpResult[]> {
  const results: UndoOpResult[] = [];
  const ops = item.planned.ops;
  say(`— "${item.planned.title}" (${item.itemKey}, journal outcome: ${item.outcome})`);

  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i];
    const state = item.ops[i];
    const push = (outcome: UndoOpResult['outcome'], path: string, detail?: string) => {
      results.push({ itemKey: item.itemKey, op: op.op, path, outcome, detail });
      const mark = outcome === 'reverted' ? '✓' : outcome === 'dry-run' ? '·' : outcome === 'conflict' || outcome === 'failed' ? '✗' : '○';
      say(`   ${mark} [${op.op}] ${path}${detail ? ` — ${detail}` : ''} (${outcome})`);
    };

    if (!state.attempted && !state.done && state.doneSteps.length === 0) continue; // never started — nothing to reverse

    if (op.op === 'move') {
      const partial = op.partial ?? `${op.to}${PARTIAL_SUFFIX}`;
      const fromSt = await fs.stat(op.from);
      const toSt = await fs.stat(op.to);
      const partialSt = await fs.stat(partial);

      if (partialSt) {
        // A stranded partial was never verified+finalized — delete the debris.
        if (apply) await fs.unlink(partial);
        push(apply ? 'reverted' : 'dry-run', partial, 'stranded partial deleted (never verified)');
      }
      if (toSt && fromSt) {
        // Crash between finalize and delete-source: both exist. Only delete the
        // COPY, and only when it verifiably equals the original.
        const [hFrom, hTo] = [await fs.hashFile(op.from), await fs.hashFile(op.to)];
        if (hFrom && hTo && hFrom.sha256 === hTo.sha256) {
          if (apply) await fs.unlink(op.to);
          push(apply ? 'reverted' : 'dry-run', op.to, 'duplicate copy deleted (checksums equal, original kept)');
        } else {
          push('conflict', op.to, 'both source and target exist with DIFFERENT content — manual review required');
        }
        continue;
      }
      if (toSt && !fromSt) {
        // The normal completed move — reverse it with the same verified procedure.
        if (!apply) {
          push('dry-run', op.to, `would move back → ${op.from}`);
          continue;
        }
        try {
          await fs.mkdirp(posixDirname(op.from));
          await performVerifiedMove(fs, { from: op.to, to: op.from, expectedBytes: op.bytes, caseOnly: op.caseOnly });
          push('reverted', op.to, `moved back → ${op.from}`);
        } catch (err) {
          const msg = err instanceof MoveError ? `${err.step}: ${err.message}` : err instanceof Error ? err.message : String(err);
          push('failed', op.to, msg);
        }
        continue;
      }
      if (!toSt && fromSt) {
        push('already-reverted', op.from, 'source already back in place');
        continue;
      }
      if (!toSt && !fromSt && !partialSt) {
        push('conflict', op.from, 'file exists at NEITHER side — manual review required');
      }
      continue;
    }

    if (op.op === 'write-plexmatch') {
      if (!state.done) continue;
      const current = await fs.readFile(op.path);
      if (current === null) {
        push('already-reverted', op.path, 'file already gone');
        continue;
      }
      if (current !== op.content) {
        push('conflict', op.path, 'content differs from what this run wrote (hand-edited since?) — never clobbered');
        continue;
      }
      if (!apply) {
        push('dry-run', op.path, op.priorContent === null ? 'would delete' : 'would restore prior content');
        continue;
      }
      if (op.priorContent === null) await fs.unlink(op.path);
      else await fs.writeFile(op.path, op.priorContent);
      push('reverted', op.path);
      continue;
    }

    if (op.op === 'mkdir') {
      if (!state.done) continue;
      if (!apply) {
        push('dry-run', op.path, 'would rmdir if empty');
        continue;
      }
      const r = await fs.rmdirIfEmpty(op.path);
      push(r === 'removed' ? 'reverted' : 'nothing-to-do', op.path, r);
      continue;
    }

    // rmdir-if-empty: nothing to reverse — the move-reversal's mkdirp recreates dirs.
    push('nothing-to-do', op.path);
  }
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const pathArg = args.find((a) => !a.startsWith('--'));

  const journalPath = pathArg ? resolve(pathArg) : findLatestJournal(defaultJournalDir);
  if (!journalPath || !existsSync(journalPath)) {
    console.error(`No rename journal found${pathArg ? ` at ${journalPath}` : ` in ${defaultJournalDir}`}.`);
    process.exitCode = 1;
    return;
  }

  console.log(`── plex-rename-undo (${apply ? 'APPLY' : 'DRY RUN — pass --apply to actually revert'}) ──`);
  console.log(`Reading ${journalPath}\n`);

  const records = readJournal(journalPath);
  const results = await runUndo(records, { apply });

  const outPath = journalPath.replace(/\.ndjson$/, `-undo-results-${apply ? 'applied' : 'dry-run'}.json`);
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nWrote undo results to ${outPath}`);

  const failures = results.filter((r) => r.outcome === 'failed' || r.outcome === 'conflict').length;
  if (failures > 0) {
    console.error(`✗ ${failures} op(s) failed/conflicted — review the results file.`);
    process.exitCode = 1;
  }
}

// Only run when invoked directly (tsx scripts/plex-rename-undo.ts), not when imported by a test.
if (process.argv[1] && process.argv[1].endsWith('plex-rename-undo.ts')) {
  main();
}
