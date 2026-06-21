import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { JobContext } from '../../core/types.js';
import { capStatus, getWorkItem, isWorkItemDone, markWorkItem, recordUsage, workItemCounts } from '../../db/store.js';
import { QuotaExceededError, callService } from '../../core/services.js';
import { enrichConfig, placesConfig } from './config.js';
import type { EnrichedFile, EnrichedPlace, ResolvedFile } from './types.js';

const JOB_NAME = 'places-enrich';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface FetchResult {
  ok: boolean;
  /** Quota/rate exhausted (HTTP 429 or RESOURCE_EXHAUSTED) — stop gracefully. */
  rateLimited: boolean;
  /** Auth/permission problem (bad key, API disabled) — affects every call. */
  authError: boolean;
  status: number;
  data?: Record<string, unknown>;
  error?: string;
}

/**
 * Enrich resolved places via the Places API (New) Place Details endpoint.
 *
 * Design constraints (free Enterprise+Atmosphere tier = 1000 calls/month):
 *  - Incremental: a place enriched successfully is NEVER re-enriched.
 *  - Budget-aware: stops at `monthlyLimit` successful calls per calendar month,
 *    so the default run stays inside the free tier ($0).
 *  - Quits gracefully if the API returns a rate/quota error (429).
 *  - Designed to run weekly: each run picks up whatever is still un-enriched,
 *    within that month's remaining budget. ~1766 places => ~2 months to finish.
 */
export async function runEnrich(ctx: JobContext): Promise<void> {
  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log('places-enrich starting');

  if (enrichConfig.dryRun) ctx.log('DRY RUN — no real API calls, no quota used, fabricated data.', 'warn');
  if (!enrichConfig.apiKey && !enrichConfig.dryRun) {
    throw new Error('GOOGLE_MAPS_API_KEY is not set. Add it to .env (see job instructions).');
  }
  if (!existsSync(placesConfig.resolvedOut)) {
    throw new Error(`resolved.json not found — run cid-to-place-id-resolver first (${placesConfig.resolvedOut})`);
  }

  const resolved = (JSON.parse(readFileSync(placesConfig.resolvedOut, 'utf8')) as ResolvedFile).resolved;
  const resolvedOk = Object.values(resolved).filter((r) => r.status === 'success' && r.placeId);
  ctx.log(`Resolved places available: ${resolvedOk.length} (with a place_id)`);

  const enriched: Record<string, EnrichedPlace> = existsSync(placesConfig.enrichedOut)
    ? (JSON.parse(readFileSync(placesConfig.enrichedOut, 'utf8')) as EnrichedFile).enriched
    : {};

  // Idempotency via the work_items ledger, keyed by place_id (success, or failed
  // past the retry budget = done). enriched.json still holds the data payload.
  const todo = resolvedOk.filter((r) => !isWorkItemDone(JOB_NAME, r.placeId!, enrichConfig.maxAttempts));
  const ledger = workItemCounts(JOB_NAME);
  const cap0 = capStatus(JOB_NAME, enrichConfig.dailyCap, enrichConfig.monthlyCap);

  ctx.log(`Ledger so far: ${JSON.stringify(ledger)}`);
  ctx.log(`Spend caps — today: ${cap0.today}/${enrichConfig.dailyCap}, month: ${cap0.month}/${enrichConfig.monthlyCap}`);
  ctx.log(`Still to enrich: ${todo.length} (new + retryable failures, up to ${enrichConfig.maxAttempts} attempts each)`);

  if (todo.length === 0) {
    ctx.progress(100, 'nothing to do — all resolved places already enriched');
    ctx.log('Nothing to enrich — every resolved place is already done. ✓');
    return;
  }
  if (!cap0.allowed) {
    ctx.log(`Spend cap already reached — ${cap0.reason}. Re-run later to continue.`, 'warn');
    return;
  }

  const perRunCap = enrichConfig.runLimit > 0 ? enrichConfig.runLimit : Infinity;
  const willAttempt = Math.min(todo.length, cap0.monthLeft, cap0.dayLeft, perRunCap);
  ctx.log(`This run will enrich up to ${willAttempt} place(s).`);

  let okCount = 0;
  let failCount = 0;
  let consecutiveFails = 0;
  let usedToday = cap0.today;
  let usedMonth = cap0.month;
  let stopReason = 'completed all available';

  for (let i = 0; i < todo.length; i++) {
    if (okCount + failCount >= perRunCap) {
      stopReason = `per-run limit reached (${enrichConfig.runLimit})`;
      ctx.log(`Reached per-run limit of ${enrichConfig.runLimit} — stopping; the next daily run continues.`);
      break;
    }
    if (usedMonth >= enrichConfig.monthlyCap) {
      stopReason = `monthly cap reached (${enrichConfig.monthlyCap})`;
      ctx.log(`Reached monthly cap of ${enrichConfig.monthlyCap} — stopping for this month.`, 'warn');
      break;
    }
    if (usedToday >= enrichConfig.dailyCap) {
      stopReason = `daily cap reached (${enrichConfig.dailyCap})`;
      ctx.log(`Reached daily cap of ${enrichConfig.dailyCap} — stopping; the next daily run continues.`, 'warn');
      break;
    }
    const place = todo[i];
    const placeId = place.placeId!; // guaranteed non-null by the resolvedOk filter
    const attempts = (getWorkItem(JOB_NAME, placeId)?.attempts ?? 0) + 1;
    // Route the paid call through the shared 'google-places' service (rate + quota
    // enforced across all jobs). A hit service quota is a graceful stop.
    let res: FetchResult;
    try {
      res = await callService('google-places', () => fetchPlaceDetails(placeId));
    } catch (e) {
      if (e instanceof QuotaExceededError) {
        stopReason = `google-places ${e.window} service cap reached (${e.used}/${e.cap})`;
        ctx.log(`google-places ${e.window} service cap reached — stopping gracefully; next run resumes.`, 'warn');
        break;
      }
      throw e;
    }

    if (res.rateLimited) {
      // Quota/rate exhausted (429 or RESOURCE_EXHAUSTED) — e.g. the Cloud daily
      // cap was reached. Stop gracefully; the next daily run continues.
      stopReason = 'API quota/rate limit reached (429 / RESOURCE_EXHAUSTED)';
      ctx.log(`Quota/rate limit hit on "${place.name}" — stopping run gracefully; next run resumes.`, 'warn');
      break;
    }
    if (res.authError) {
      // A bad/disabled key or revoked permission breaks EVERY call. Fail loudly
      // instead of marking everything failed and burning the daily quota.
      throw new Error(`Places API auth/permission error (check GOOGLE_MAPS_API_KEY): HTTP ${res.status} — ${res.error}`);
    }

    // A real (metered) call happened.
    recordUsage(JOB_NAME);
    usedToday++; usedMonth++;

    if (res.ok && res.data) {
      enriched[place.cid] = { cid: place.cid, placeId, status: 'success', enrichedAt: new Date().toISOString(), attempts, data: res.data };
      const d = res.data;
      const dn = (d.displayName as { text?: string } | undefined)?.text ?? place.name;
      markWorkItem(JOB_NAME, placeId, 'success', { attempts, detail: { cid: place.cid, name: dn } });
      okCount++;
      const ptype = (d.primaryTypeDisplayName as { text?: string } | undefined)?.text ?? '—';
      ctx.log(`[${i + 1}] ENRICHED "${dn}"`);
      ctx.log(`      place_id: ${placeId}`);
      ctx.log(`      rating:   ${d.rating ?? '—'} (${d.userRatingCount ?? 0} reviews)`);
      ctx.log(`      type:     ${ptype}`);
      ctx.log(`      price:    ${d.priceLevel ?? '—'}`);
      ctx.log(`      address:  ${d.formattedAddress ?? '—'}`);
      ctx.log(`      spend:    ${usedMonth}/${enrichConfig.monthlyCap} month · ${usedToday}/${enrichConfig.dailyCap} today`);
      consecutiveFails = 0;
    } else {
      enriched[place.cid] = { cid: place.cid, placeId, status: 'failed', enrichedAt: new Date().toISOString(), attempts, error: res.error };
      markWorkItem(JOB_NAME, placeId, 'failed', { attempts, detail: { name: place.name, error: res.error } });
      failCount++;
      consecutiveFails++;
      const note = attempts >= enrichConfig.maxAttempts ? ' — giving up (max attempts)' : `; will retry (attempt ${attempts}/${enrichConfig.maxAttempts})`;
      ctx.log(`[${i + 1}] FAILED "${place.name}" — HTTP ${res.status}: ${res.error}${note}`, 'warn');
      if (consecutiveFails >= 5) {
        // Something systemic (not a single bad place_id). Stop to avoid wasting quota.
        stopReason = `stopped after ${consecutiveFails} consecutive failures`;
        ctx.log(`${consecutiveFails} failures in a row — stopping the run to avoid burning quota. Investigate.`, 'error');
        break;
      }
    }

    if ((okCount + failCount) % 10 === 0) persistEnriched(enriched);
    ctx.progress((Math.min(i + 1, willAttempt) / willAttempt) * 100, `Enriched ${okCount}`);
    if (i < todo.length - 1) await sleep(enrichConfig.delayMs);
  }

  persistEnriched(enriched);

  ctx.progress(100, `enriched ${okCount}, failed ${failCount}`);
  const finalLedger = workItemCounts(JOB_NAME);
  ctx.log('');
  ctx.log('═══════════════ ENRICH SUMMARY ═══════════════');
  ctx.log(`Stop reason:          ${stopReason}`);
  ctx.log(`This run — enriched:  ${okCount},  failed: ${failCount}`);
  ctx.log(`Spend used:           ${usedMonth}/${enrichConfig.monthlyCap} month · ${usedToday}/${enrichConfig.dailyCap} today`);
  ctx.log(`Ledger (lifetime):    ${JSON.stringify(finalLedger)}`);
  ctx.log(`Overall enriched:     ${(finalLedger.success ?? 0)}/${resolvedOk.length}`);
  ctx.log(`Wrote ${placesConfig.enrichedOut}`);
  ctx.log('═══════════════════════════════════════════════');
}

/** Call Places API (New) Place Details, or fabricate one in dry-run mode. */
async function fetchPlaceDetails(placeId: string): Promise<FetchResult> {
  if (enrichConfig.dryRun) {
    return {
      ok: true, rateLimited: false, authError: false, status: 200,
      data: {
        id: placeId,
        displayName: { text: '(dry-run place)' },
        primaryTypeDisplayName: { text: 'restaurant' },
        rating: 4.3, userRatingCount: 256, priceLevel: 'PRICE_LEVEL_MODERATE',
        formattedAddress: '(dry-run address)',
      },
    };
  }
  try {
    const res = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
      headers: {
        'X-Goog-Api-Key': enrichConfig.apiKey,
        'X-Goog-FieldMask': enrichConfig.fieldMask,
      },
    });
    if (res.ok) {
      return { ok: true, rateLimited: false, authError: false, status: 200, data: (await res.json()) as Record<string, unknown> };
    }
    // Classify the error by the API's status string (more reliable than HTTP code,
    // since quota exhaustion can arrive as 429 OR 403 RESOURCE_EXHAUSTED).
    const body = await res.text();
    let apiStatus = '';
    try {
      apiStatus = (JSON.parse(body) as { error?: { status?: string } })?.error?.status ?? '';
    } catch {
      /* non-JSON body */
    }
    const quota = res.status === 429 || apiStatus === 'RESOURCE_EXHAUSTED';
    // Key/permission problems break every call — match by code, status, or the
    // tell-tale messages (an invalid key is a 400 INVALID_ARGUMENT, not a 401/403).
    const keyProblem = /api key not valid|api_key_invalid|api keys are not|permission denied|service is disabled|has not been used in project|it is disabled/i.test(body);
    const auth = !quota && (res.status === 401 || res.status === 403 || apiStatus === 'PERMISSION_DENIED' || apiStatus === 'UNAUTHENTICATED' || keyProblem);
    return {
      ok: false, rateLimited: quota, authError: auth, status: res.status,
      error: `${apiStatus ? apiStatus + ' ' : ''}${body.slice(0, 160)}`,
    };
  } catch (err) {
    return { ok: false, rateLimited: false, authError: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

function persistEnriched(enriched: Record<string, EnrichedPlace>): void {
  const file: EnrichedFile = { generatedAt: new Date().toISOString(), enriched };
  writeFileSync(placesConfig.enrichedOut, JSON.stringify(file, null, 2));
}
