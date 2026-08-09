// The copy → checksum-verify → delete-original move procedure — the ONLY way
// this workflow ever relocates a file, shared by the apply stage and the undo
// script. The owner's hard rule it encodes: an original is NEVER deleted until
// a checksum-verified copy of it exists under the final target name (or, for
// case-only renames, under the partial name — see below). The worst outcome of
// a crash at ANY point is a dead extra file, never a lost or corrupted one.
import { posixDirname } from './naming.js';
import type { WriteFsSeam } from './lib.js';

/** The temp suffix — never a media extension, so Plex can never scan a half-copy. */
export const PARTIAL_SUFFIX = '.plexrename-partial';

export type MoveStep = 'copy' | 'verify' | 'finalize' | 'delete-source';

export interface MovePlanPaths {
  from: string;
  to: string;
  /** The staging path; defaults to `<to>.plexrename-partial`. */
  partial?: string;
  /** Expected source size in bytes (a pre-copy hard gate when provided). */
  expectedBytes?: number;
  /**
   * Case-only rename on a case-insensitive filesystem: `to` and `from` are the
   * SAME directory entry, so finalize-before-delete would collide. The step
   * order becomes copy → verify → delete-source → finalize; the verified
   * partial (not the finalized target) is what guarantees the bytes survive
   * the delete.
   */
  caseOnly?: boolean;
}

export interface MoveHooks {
  /** Journal seam: flushed BEFORE the step's filesystem effect runs. */
  before?(step: MoveStep): void | Promise<void>;
  /** Journal seam: flushed after the step's filesystem effect returned. */
  after?(step: MoveStep, info?: { sha256?: string; bytes?: number }): void | Promise<void>;
}

export class MoveError extends Error {
  constructor(
    public readonly step: MoveStep | 'preflight',
    message: string,
  ) {
    super(message);
    this.name = 'MoveError';
  }
}

/**
 * Execute one verified move. Ordered, hard-gated steps:
 *
 *  preflight — source exists at exactly `expectedBytes`; target absent (unless
 *              caseOnly); no stale partial in the way.
 *  copy      — stream source → partial, hashing the READ bytes; fsync partial.
 *  verify    — re-read the WRITTEN partial and hash it; size AND SHA-256 must
 *              equal the source's. Mismatch → the partial is deleted, the
 *              source untouched, MoveError('verify') thrown.
 *  finalize  — atomically rename partial → target; stat target to confirm.
 *  delete-source — only now, with a verified copy durable under the final name.
 *
 * (caseOnly swaps the last two — see MovePlanPaths.caseOnly.)
 *
 * Returns the verified SHA-256. Throws MoveError with the failed step; the
 * source file is guaranteed untouched unless the FINAL step (the one deleting
 * it) was reached, and that step only runs after verify + finalize succeeded.
 */
export async function performVerifiedMove(fs: WriteFsSeam, plan: MovePlanPaths, hooks: MoveHooks = {}): Promise<{ sha256: string; bytes: number }> {
  const partial = plan.partial ?? `${plan.to}${PARTIAL_SUFFIX}`;

  // ── preflight: the disk must be EXACTLY as expected ──
  const srcSt = await fs.stat(plan.from);
  if (!srcSt || !srcSt.isFile) throw new MoveError('preflight', `source missing: ${plan.from}`);
  if (plan.expectedBytes !== undefined && srcSt.size !== plan.expectedBytes) {
    throw new MoveError('preflight', `source size ${srcSt.size} ≠ expected ${plan.expectedBytes}: ${plan.from}`);
  }
  if (!plan.caseOnly && (await fs.stat(plan.to))) {
    throw new MoveError('preflight', `target already exists (never overwritten): ${plan.to}`);
  }
  if (await fs.stat(partial)) {
    throw new MoveError('preflight', `stale partial in the way (crash debris — reconcile first): ${partial}`);
  }

  // ── copy ──
  await hooks.before?.('copy');
  await fs.mkdirp(posixDirname(plan.to));
  const copied = await fs.copyStreamHashed(plan.from, partial);
  await hooks.after?.('copy', copied);

  // ── verify ──
  await hooks.before?.('verify');
  const written = await fs.hashFile(partial);
  if (!written || written.bytes !== copied.bytes || written.sha256 !== copied.sha256 || written.bytes !== srcSt.size) {
    // The copy is bad — delete IT (never the source) and fail the item.
    await fs.unlink(partial).catch(() => {});
    throw new MoveError(
      'verify',
      `checksum/size mismatch copying ${plan.from} → ${partial}: read ${copied.bytes}B ${copied.sha256}, wrote ${written?.bytes ?? 'missing'}B ${written?.sha256 ?? ''}`,
    );
  }
  await hooks.after?.('verify', written);

  const finalize = async () => {
    await hooks.before?.('finalize');
    await fs.rename(partial, plan.to);
    const finalSt = await fs.stat(plan.to);
    if (!finalSt || !finalSt.isFile || finalSt.size !== copied.bytes) {
      throw new MoveError('finalize', `finalized target failed its stat check: ${plan.to}`);
    }
    await hooks.after?.('finalize');
  };
  const deleteSource = async () => {
    await hooks.before?.('delete-source');
    await fs.unlink(plan.from);
    await hooks.after?.('delete-source');
  };

  if (plan.caseOnly) {
    await deleteSource();
    await finalize();
  } else {
    await finalize();
    await deleteSource();
  }
  return copied;
}
