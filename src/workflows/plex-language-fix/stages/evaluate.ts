import type { JobContext } from '../../../core/types.js';
import { getWorkItem, isWorkItemDone, markWorkItem } from '../../../db/store.js';
import { evaluatePart, fetchItemDetail } from '../lib.js';
import type { DiscoverDetail, EvaluateDetail, ResolveDetail } from '../types.js';
import { ledgerSuccessRows } from './ledger.js';

export const JOB_NAME = 'plex-language-evaluate';
const MAX_ATTEMPTS = 3;

/** Injectable seam for tests — defaults to the real Plex-touching lib.ts function. */
export interface PlexFetchOverrides {
  fetchItemDetail?: typeof fetchItemDetail;
}

/**
 * For every file that's been both discovered AND resolved but not yet evaluated,
 * fetch its LIVE current Plex stream selection and compare it against resolve's
 * candidate languages (reusing `evaluatePart`/`pickAudioCandidate` from lib.ts)
 * to decide `'change'` or `'skip'`. Read-only. Every file records its own
 * permanent ledger row, so a file is evaluated exactly once, ever — a real-world
 * drift after that point (someone manually re-picks a track) is NOT re-detected
 * automatically; that is an accepted trade-off of "process once, forever" over
 * "re-scan fresh every run".
 */
export async function runEvaluate(ctx: JobContext, opts: PlexFetchOverrides = {}): Promise<void> {
  const doFetchItemDetail = opts.fetchItemDetail ?? fetchItemDetail;

  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log('plex-language-evaluate starting — read-only.');

  const discovered = ledgerSuccessRows('plex-language-discover');
  const resolvedByKey = new Map(ledgerSuccessRows('plex-language-resolve').map((r) => [r.itemKey, r.detail as ResolveDetail]));

  const todo = discovered.filter(
    (r) => ctx.rootAllowed(r.itemKey) && resolvedByKey.has(r.itemKey) && !isWorkItemDone(JOB_NAME, r.itemKey, MAX_ATTEMPTS),
  );
  ctx.log(`${todo.length} file(s) need evaluation`);

  let changes = 0;
  let skipped = 0;
  let failed = 0;
  for (let i = 0; i < todo.length; i++) {
    const { itemKey, detail } = todo[i];
    const d = detail as DiscoverDetail;
    const resolveInfo = resolvedByKey.get(itemKey)!;
    const attempts = (getWorkItem(JOB_NAME, itemKey)?.attempts ?? 0) + 1;
    try {
      const itemDetail = await doFetchItemDetail(d.itemRatingKey);
      const part = (itemDetail?.Media ?? []).flatMap((m) => m.Part ?? []).find((p) => p.id === d.partId);
      if (!part) {
        // The file Plex reported at discovery is no longer on this item (replaced,
        // removed, re-keyed). Recorded as a counted failure rather than silently
        // re-attempted every night: after MAX_ATTEMPTS it stops and shows as stuck.
        const message = `part ${d.partId} no longer found on this item`;
        markWorkItem(JOB_NAME, itemKey, 'failed', { attempts, detail: { name: d.name, error: message } });
        failed++;
        ctx.log(`  ⚠ "${d.name}" — ${message} (attempt ${attempts}/${MAX_ATTEMPTS})`, 'warn');
        continue;
      }
      const entry = evaluatePart(d.itemRatingKey, d.name, d.seasonEpisode, part, resolveInfo.candidateLanguages);
      if (entry.status === 'change') changes++;
      else skipped++;
      const result: EvaluateDetail = {
        name: d.name,
        status: entry.status,
        currentAudio: entry.currentAudio,
        currentSubtitle: entry.currentSubtitle,
        proposedAudio: entry.proposedAudio,
        proposedSubtitle: entry.proposedSubtitle,
      };
      markWorkItem(JOB_NAME, itemKey, 'success', { attempts, detail: result });
      if ((i + 1) % 50 === 0) ctx.log(`  [${i + 1}/${todo.length}] evaluated…`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      markWorkItem(JOB_NAME, itemKey, 'failed', { attempts, detail: { name: d.name, error: message } });
      failed++;
      ctx.log(`  ✗ "${d.name}" — ${message} (attempt ${attempts}/${MAX_ATTEMPTS})`, 'warn');
    }
    ctx.progress(Math.round(((i + 1) / Math.max(todo.length, 1)) * 100), `${i + 1}/${todo.length} evaluated`);
  }

  ctx.log('═══════════════ EVALUATE SUMMARY ═══════════════');
  ctx.log(`Evaluated ${changes + skipped}/${todo.length} file(s) — ${changes} change(s) proposed, ${skipped} skip(s), ${failed} failed.`);
  ctx.log('══════════════════════════════════════════════');
  ctx.progress(100, `${changes} change(s), ${skipped} skip(s)`);

  if (failed > 0) {
    throw new Error(`${failed}/${changes + skipped + failed} file(s) failed evaluation this run — see the ✗ / ⚠ lines above`);
  }
}
