import type { JobContext } from '../../../core/types.js';
import { isWorkItemDone, markWorkItem } from '../../../db/store.js';
import { callService, QuotaExceededError } from '../../../core/services.js';
import { buildCandidateLanguages, lookupLanguageDetail } from '../lib.js';
import type { DiscoverDetail, ResolveDetail } from '../types.js';
import { ledgerSuccessRows } from './ledger.js';

export const JOB_NAME = 'plex-language-resolve';
const MAX_ATTEMPTS = 3;

/** Injectable seam for tests — defaults to the real `lib.ts` TMDB lookup. */
export interface TmdbLookupOverrides {
  lookupLanguageDetail?: typeof lookupLanguageDetail;
}

/**
 * For every discovered file not yet resolved, look up its show/movie's true
 * original language via TMDB. The TMDB call is routed through
 * `callService('tmdb', ..., { cacheKey })` keyed by `tmdb-language:<type>:<tmdbId>`
 * (T451's opt-in response cache) — every OTHER file belonging to the same
 * show/movie resolved within the same 5-minute window reuses the cached response
 * instead of making a redundant TMDB call, even though every file still records
 * its OWN per-file ledger row. Read-only; a hit TMDB quota is caught per-file and
 * stops the run gracefully (the item is left un-done and retried next run).
 */
export async function runResolve(ctx: JobContext, opts: TmdbLookupOverrides = {}): Promise<void> {
  const doLookupLanguageDetail = opts.lookupLanguageDetail ?? lookupLanguageDetail;

  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log('plex-language-resolve starting — read-only, TMDB lookups only.');

  const discovered = ledgerSuccessRows('plex-language-discover');
  const todo = discovered.filter((r) => ctx.rootAllowed(r.itemKey) && !isWorkItemDone(JOB_NAME, r.itemKey, MAX_ATTEMPTS));
  ctx.log(`${todo.length}/${discovered.length} discovered file(s) need language resolution`);

  let resolved = 0;
  let quotaStopped = false;
  for (let i = 0; i < todo.length; i++) {
    const { itemKey, detail } = todo[i];
    const d = detail as DiscoverDetail;
    try {
      const info = await callService('tmdb', () => doLookupLanguageDetail(d.tmdbId, d.type), {
        cacheKey: `tmdb-language:${d.type}:${d.tmdbId}`,
      });
      const candidateLanguages = buildCandidateLanguages(info.originalLanguage, info.spokenLanguages);
      const result: ResolveDetail = { name: d.name, originalLanguage: info.originalLanguage, candidateLanguages };
      markWorkItem(JOB_NAME, itemKey, 'success', { detail: result });
      resolved++;
      if ((i + 1) % 50 === 0) ctx.log(`  [${i + 1}/${todo.length}] resolved…`);
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        ctx.log(`TMDB ${err.window} cap reached (${err.used}/${err.cap}) — stopping gracefully.`, 'warn');
        quotaStopped = true;
        break;
      }
      ctx.log(`  ✗ "${d.name}" — ${err instanceof Error ? err.message : err}`, 'warn');
    }
    ctx.progress(Math.round(((i + 1) / Math.max(todo.length, 1)) * 100), `${i + 1}/${todo.length} resolved`);
  }

  ctx.log('═══════════════ RESOLVE SUMMARY ═══════════════');
  ctx.log(`Resolved ${resolved}/${todo.length} file(s)${quotaStopped ? ' (stopped early — TMDB quota)' : ''}.`);
  ctx.log('═══════════════════════════════════════════');
  ctx.progress(100, `${resolved}/${todo.length} resolved`);
}
