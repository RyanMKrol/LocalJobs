import type { JobContext } from '../../../core/types.js';
import { isWorkItemDone, markWorkItem } from '../../../db/store.js';
import { plexRenameConfig } from '../config.js';
import { fetchItemDetail } from '../lib.js';
import type { ApplyDetail, ConfirmDetail, DiscoverDetail } from '../types.js';
import { ledgerSuccessRows } from './ledger.js';

export const JOB_NAME = 'plex-rename-confirm';
export const APPLY_JOB = 'plex-rename-apply';
export const DISCOVER_JOB = 'plex-rename-discover';
const MAX_ATTEMPTS = 3;

export interface ConfirmOverrides {
  fetchItemDetail?: typeof fetchItemDetail;
  readApplyRows?: () => { itemKey: string; detail: unknown }[];
  readDiscoverRows?: () => { itemKey: string; detail: unknown }[];
  graceDays?: number;
  now?: () => Date;
}

function parseKey(itemKey: string): { ratingKey: string; partId: number } {
  const idx = itemKey.lastIndexOf('::part');
  return { ratingKey: itemKey.slice(0, idx), partId: Number(itemKey.slice(idx + 6)) };
}

/**
 * The canonical id tag embedded in a target path by the naming engine —
 * `{tvdb-401003}` / `{tmdb-1429}` / `{imdb-tt1179933}`. Because that tag was
 * DERIVED from the pre-move item's own GUIDs, matching it against whatever Plex
 * now reports at the path is a genuine identity check, not merely "some file is
 * sitting there".
 */
export function idTagsOf(path: string): string[] {
  return [...path.matchAll(/\{(tvdb|tmdb|imdb)-([^}]+)\}/g)].map((m) => `${m[1]}-${m[2]}`.toLowerCase());
}

/** The id tags a discover snapshot row's own show/movie refs assert. */
export function idTagsOfDiscoverRow(d: DiscoverDetail): string[] {
  const out: string[] = [];
  const s = d.show;
  const m = d.movie;
  if (s?.tvdbId !== undefined) out.push(`tvdb-${s.tvdbId}`);
  if (s?.tmdbId !== undefined) out.push(`tmdb-${s.tmdbId}`);
  if (s?.imdbId) out.push(`imdb-${s.imdbId}`.toLowerCase());
  if (m?.tmdbId !== undefined) out.push(`tmdb-${m.tmdbId}`);
  if (m?.imdbId) out.push(`imdb-${m.imdbId}`.toLowerCase());
  return out;
}

/**
 * Index THIS run's discover snapshot by Plex-side path. Consolidation legitimately
 * retires a duplicate show entry (and its episode items) when a split show is
 * merged into one folder, so an applied file's ORIGINAL ratingKey can 404 while the
 * file is perfectly matched under a new one. Discover already re-walked the live
 * library at the top of this same run, so the answer is already on hand — no extra
 * Plex calls.
 */
function indexSnapshotByPath(rows: { itemKey: string; detail: unknown }[]): Map<string, { ratingKey: string; idTags: string[] }> {
  const map = new Map<string, { ratingKey: string; idTags: string[] }>();
  for (const r of rows) {
    const d = r.detail as DiscoverDetail | undefined;
    if (!d?.file) continue;
    const idx = r.itemKey.lastIndexOf('::part');
    map.set(d.file.normalize('NFC'), {
      ratingKey: idx > 0 ? r.itemKey.slice(0, idx) : r.itemKey,
      idTags: idTagsOfDiscoverRow(d),
    });
  }
  return map;
}

/**
 * Post-rename verification that PLEX ITSELF re-associated each moved file at
 * the SAME ratingKey (watch state, collections, and metadata intact). For each
 * applied-but-not-yet-confirmed item, a LIVE metadata fetch:
 *  - same ratingKey now reports the new path → confirmed (once-ever success);
 *  - still the old path → Plex just hasn't rescanned: recorded 'skipped'
 *    (retryable) and re-checked next run, until the grace window
 *    (PLEX_RENAME_CONFIRM_GRACE_DAYS) expires — then it fails LOUD;
 *  - the same ratingKey is gone OR reports some other file, BUT this run's
 *    discover snapshot shows a Plex item sitting at exactly our target path whose
 *    own ids match the ones the canonical name embeds → confirmed as
 *    'reassociated'. This is the routine outcome of consolidating a show that Plex
 *    held as TWO split entries: merging the folders retires the duplicate entry and
 *    its episode items, so the original ratingKey legitimately disappears while the
 *    file stays correctly matched (verified live in 2026-08: watch state survives).
 *  - nothing at the target path either → the genuine alarm (a moved file Plex has
 *    lost track of). Held as pending inside the grace window (a rescan may still
 *    land — the bytes themselves were checksum-verified at apply time), then fails
 *    LOUD. plex-library-guard independently screams about a vanished key too —
 *    two detectors, by design.
 */
export async function runConfirm(ctx: JobContext, opts: ConfirmOverrides = {}): Promise<void> {
  const doFetch = opts.fetchItemDetail ?? fetchItemDetail;
  const readApplyRows = opts.readApplyRows ?? (() => ledgerSuccessRows(APPLY_JOB));
  const readDiscoverRows = opts.readDiscoverRows ?? (() => ledgerSuccessRows(DISCOVER_JOB));
  const graceDays = opts.graceDays ?? plexRenameConfig.confirmGraceDays;
  const now = opts.now ?? (() => new Date());

  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log(`plex-rename-confirm starting — live re-association check (grace window ${graceDays} day(s)).`);

  const pending = readApplyRows().filter((r) => ctx.rootAllowed(r.itemKey) && !isWorkItemDone(JOB_NAME, r.itemKey, MAX_ATTEMPTS));
  ctx.log(`Applied items awaiting confirmation: ${pending.length}`);
  ctx.progress(5, `${pending.length} to confirm`);

  const snapshot = indexSnapshotByPath(readDiscoverRows());
  ctx.log(`Discover snapshot indexed by path: ${snapshot.size} live library file(s) — used to resolve consolidation re-associations.`);

  /**
   * Is our target path occupied by a Plex item asserting the SAME identity the
   * canonical name embeds? Returns the owning ratingKey when so.
   */
  const reassociatedAt = (targetPath: string): { ratingKey: string; matched: string[] } | null => {
    const hit = snapshot.get(targetPath.normalize('NFC'));
    if (!hit) return null;
    const wanted = idTagsOf(targetPath);
    // No id tag in the path at all (shouldn't happen — the engine refuses to name
    // without one) means we cannot prove identity: don't claim confirmation.
    if (wanted.length === 0) return null;
    const matched = wanted.filter((t) => hit.idTags.includes(t));
    return matched.length > 0 ? { ratingKey: hit.ratingKey, matched } : null;
  };

  let confirmed = 0;
  let reassociated = 0;
  let stillPending = 0;
  let failed = 0;

  for (let i = 0; i < pending.length; i++) {
    const row = pending[i];
    const apply = row.detail as ApplyDetail;
    const { ratingKey, partId } = parseKey(row.itemKey);
    const record = (detail: ConfirmDetail, status: 'success' | 'failed' | 'skipped') => {
      markWorkItem(JOB_NAME, row.itemKey, status, { detail });
    };

    /** Second chance for every non-same-ratingKey outcome: is the file matched under a NEW item? */
    const tryReassociation = (why: string): boolean => {
      const hit = reassociatedAt(apply.to);
      if (!hit) return false;
      reassociated++;
      ctx.log(`  ✓ "${apply.name}" — ${why}, but Plex has the file matched at the target path under ratingKey ${hit.ratingKey} with matching ids (${hit.matched.join(', ')}) — a consolidation merge, not a lost item`);
      ctx.log(`      confirmed at: ${apply.to}`);
      record(
        {
          name: `${apply.name} — confirmed (re-associated)`,
          confirmed: true,
          reason: 'reassociated',
          reasonDetail: `${why}; now owned by ratingKey ${hit.ratingKey} (ids ${hit.matched.join(', ')})`,
          confirmedPath: apply.to,
          confirmedRatingKey: hit.ratingKey,
        },
        'success',
      );
      return true;
    };

    let item;
    try {
      item = await doFetch(ratingKey);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A 404 is Plex answering definitively "no such item", not a transport wobble —
      // treat it exactly like a null item so consolidation merges resolve here too.
      if (/\b404\b/.test(msg) && tryReassociation(`ratingKey ${ratingKey} no longer resolves`)) continue;
      stillPending++;
      ctx.log(`  ⚠ "${apply.name}" — Plex fetch failed (${msg}); re-checked next run`, 'warn');
      record({ name: apply.name, confirmed: false, reason: 'pending-rescan', reasonDetail: `plex fetch failed: ${msg}` }, 'skipped');
      continue;
    }

    if (!item) {
      if (tryReassociation(`ratingKey ${ratingKey} no longer resolves`)) continue;
      const goneAgeMs = now().getTime() - new Date(apply.appliedAt || 0).getTime();
      if (goneAgeMs <= graceDays * 24 * 60 * 60 * 1000) {
        stillPending++;
        ctx.log(`  · "${apply.name}" — ratingKey ${ratingKey} is gone and nothing yet sits at the target path; Plex may still be rescanning — re-checked next run`);
        record(
          { name: apply.name, confirmed: false, reason: 'pending-rescan', reasonDetail: `ratingKey ${ratingKey} gone, no item at ${apply.to} yet` },
          'skipped',
        );
        continue;
      }
      failed++;
      ctx.log(`  ✗ "${apply.name}" — ratingKey ${ratingKey} NO LONGER RESOLVES and NO Plex item owns ${apply.to} after ${Math.round(goneAgeMs / 86_400_000)}d. Plex has lost track of a file we moved — investigate; plex-library-guard should have alerted too.`, 'error');
      record(
        { name: apply.name, confirmed: false, reason: 'ratingkey-gone', reasonDetail: `ratingKey ${ratingKey} not found and nothing at ${apply.to}` },
        'failed',
      );
      continue;
    }

    const parts = (item.Media ?? []).flatMap((m) => m.Part ?? []);
    const part = parts.find((p) => p.id === partId) ?? parts[0];
    const currentPath = part?.file?.normalize('NFC');
    if (currentPath === apply.to.normalize('NFC')) {
      confirmed++;
      ctx.log(`  ✓ "${apply.name}" — Plex reports the new path at the same ratingKey ${ratingKey} (watch state/metadata intact)`);
      ctx.log(`      confirmed at: ${apply.to}`);
      record({ name: `${apply.name} — confirmed`, confirmed: true, confirmedPath: apply.to }, 'success');
      continue;
    }

    // The old item survives but points elsewhere — our file may have been merged
    // under a different item (the same consolidation case) rather than left behind.
    if (tryReassociation(`ratingKey ${ratingKey} now reports ${currentPath ?? 'no path'}`)) continue;

    const ageMs = now().getTime() - new Date(apply.appliedAt || 0).getTime();
    const graceMs = graceDays * 24 * 60 * 60 * 1000;
    if (ageMs > graceMs) {
      failed++;
      ctx.log(`  ✗ "${apply.name}" — Plex STILL reports ${currentPath ?? 'no path'} ${Math.round(ageMs / 86_400_000)}d after the rename (grace ${graceDays}d). The rescan never landed — investigate.`, 'error');
      record(
        { name: apply.name, confirmed: false, reason: 'grace-exceeded', reasonDetail: `still ${currentPath ?? 'unknown'} after ${Math.round(ageMs / 86_400_000)}d` },
        'failed',
      );
    } else {
      stillPending++;
      ctx.log(`  · "${apply.name}" — Plex hasn't picked up the new path yet (${currentPath ?? 'unknown'}); re-checked next run`);
      record({ name: apply.name, confirmed: false, reason: 'pending-rescan', reasonDetail: `still ${currentPath ?? 'unknown'}` }, 'skipped');
    }
    if ((i + 1) % 25 === 0) ctx.progress(5 + Math.round((90 * (i + 1)) / pending.length), `${i + 1}/${pending.length} checked`);
  }

  ctx.log('═══════════════ CONFIRM SUMMARY ═══════════════');
  ctx.log(`Confirmed: ${confirmed + reassociated} (${confirmed} at the original ratingKey, ${reassociated} re-associated after a consolidation merge)`);
  ctx.log(`Still pending rescan: ${stillPending} · failed: ${failed}`);
  ctx.log('═════════════════════════════════════════════');
  ctx.progress(100, `${confirmed + reassociated} confirmed, ${stillPending} pending, ${failed} failed`);
  if (failed > 0) {
    throw new Error(`${failed} renamed item(s) failed confirmation — see logs above`);
  }
}
