import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { JobContext } from '../../../core/types.js';
import { getWorkItem, isWorkItemDone, markWorkItem, serviceCallsThisMonth, serviceCallsToday, workItemCounts } from '../../../db/store.js';
import { QuotaExceededError, callService, getServiceDef } from '../../../core/services.js';
import { enrichConfig, placesConfig } from '../config.js';
import type { EnrichedFile, EnrichedPlace, ResolvedFile } from '../types.js';

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
 *  - Budget-aware: spend is governed SOLELY by the shared 'google-places' service
 *    quota (day/month), enforced inside callService — there is no longer a
 *    redundant per-job cap. When the service quota is exhausted, callService
 *    throws QuotaExceededError and the run stops gracefully ($0, inside free tier).
 *  - Quits gracefully if the API returns a rate/quota error (429).
 *  - Designed to run weekly: each run picks up whatever is still un-enriched,
 *    within that month's remaining budget. ~1766 places => ~2 months to finish.
 */
export async function runEnrich(ctx: JobContext): Promise<void> {
  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log('places-enrich starting');

  if (enrichConfig.dryRun) ctx.log('DRY RUN — no real API calls, no quota used, fabricated data.', 'warn');
  if (!enrichConfig.apiKey && !enrichConfig.dryRun) {
    throw new Error('GOOGLE_MAPS_API_KEY is not set. Add it to .env (see README — places workflow).');
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
  // Idempotent by place_id; a manual run-limit (T094) also filters to the selected
  // roots — here the root is the originating CID this place_id was resolved from.
  // Split the two reasons an item is excluded so a "0 to do" run can distinguish
  // "everything's already enriched" from "outstanding work, but none allowed by
  // this run's limit" (T163). `notDone` = resolved places still needing enriching;
  // `todo` = those of them within the run's selected roots (a no-op for unlimited).
  const notDone = resolvedOk.filter((r) => !isWorkItemDone(JOB_NAME, r.placeId!, enrichConfig.maxAttempts));
  const todo = notDone.filter((r) => ctx.rootAllowed(r.cid));
  const ledger = workItemCounts(JOB_NAME);

  // Spend is governed by the shared 'google-places' service quota (the single
  // source of truth) — read it just for visibility + headroom estimation.
  const svc = getServiceDef('google-places');
  const monthCap = svc?.monthlyCap ?? Infinity;
  const dayCap = svc?.dailyCap ?? Infinity;
  let usedMonth = serviceCallsThisMonth('google-places');
  let usedToday = serviceCallsToday('google-places');
  const monthLeft = Math.max(0, monthCap - usedMonth);
  const dayLeft = Math.max(0, dayCap - usedToday);

  ctx.log(`Ledger so far: ${JSON.stringify(ledger)}`);
  ctx.log(`Service quota (google-places) — today: ${usedToday}/${dayCap}, month: ${usedMonth}/${monthCap}`);
  ctx.log(`Still to enrich: ${todo.length} (new + retryable failures, up to ${enrichConfig.maxAttempts} attempts each)`);

  if (todo.length === 0) {
    if (notDone.length > 0) {
      // Limited run: there IS outstanding enrichment, just none in the selected roots.
      ctx.progress(100, `0 to do this run — ${notDone.length} outstanding but none in this run's selected roots`);
      ctx.log(`0 to enrich this run — ${notDone.length} resolved place(s) still need enriching, but none fall within this limited run's selected roots. Re-run unlimited (or with a higher limit) to drain them. ✓`, 'warn');
    } else {
      ctx.progress(100, 'nothing to do — all resolved places already enriched');
      ctx.log('Nothing to enrich — every resolved place is already done. ✓');
    }
    return;
  }
  if (monthLeft <= 0 || dayLeft <= 0) {
    ctx.log(`google-places service quota already exhausted (today ${usedToday}/${dayCap}, month ${usedMonth}/${monthCap}). Re-run later to continue.`, 'warn');
    return;
  }

  const perRunCap = enrichConfig.runLimit > 0 ? enrichConfig.runLimit : Infinity;
  const willAttempt = Math.min(todo.length, monthLeft, dayLeft, perRunCap);
  ctx.log(`This run will enrich up to ${willAttempt} place(s).`);

  let okCount = 0;
  let failCount = 0;
  let consecutiveFails = 0;
  let stopReason = 'completed all available';

  for (let i = 0; i < todo.length; i++) {
    if (okCount + failCount >= perRunCap) {
      stopReason = `per-run limit reached (${enrichConfig.runLimit})`;
      ctx.log(`Reached per-run limit of ${enrichConfig.runLimit} — stopping; the next daily run continues.`);
      break;
    }
    // Day/month spend is enforced by the 'google-places' service quota inside
    // callService below (a hit quota throws QuotaExceededError → graceful stop).
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
        // Record soft-stop: item was not attempted; use prior attempt count (no increment).
        markWorkItem(JOB_NAME, placeId, 'skipped', { attempts: attempts - 1, rootKey: place.cid, parentKey: place.cid, parentJob: 'cid-to-place-id-resolver', detail: { name: place.name } });
        break;
      }
      throw e;
    }

    if (res.rateLimited) {
      // Quota/rate exhausted (429 or RESOURCE_EXHAUSTED) — e.g. the Cloud daily
      // cap was reached. Stop gracefully; the next daily run continues.
      stopReason = 'API quota/rate limit reached (429 / RESOURCE_EXHAUSTED)';
      ctx.log(`Quota/rate limit hit on "${place.name}" — stopping run gracefully; next run resumes.`, 'warn');
      // Record soft-stop: quota was hit mid-call; item produced no output.
      markWorkItem(JOB_NAME, placeId, 'skipped', { attempts: attempts - 1, rootKey: place.cid, parentKey: place.cid, parentJob: 'cid-to-place-id-resolver', detail: { name: place.name } });
      break;
    }
    if (res.authError) {
      // A bad/disabled key or revoked permission breaks EVERY call. Fail loudly
      // instead of marking everything failed and burning the daily quota.
      throw new Error(`Places API auth/permission error (check GOOGLE_MAPS_API_KEY): HTTP ${res.status} — ${res.error}`);
    }

    // A real (metered) call happened — callService already recorded it against
    // the shared 'google-places' service meter; track locally just for logging.
    usedToday++; usedMonth++;

    if (res.ok && res.data) {
      enriched[place.cid] = { cid: place.cid, placeId, status: 'success', enrichedAt: new Date().toISOString(), attempts, data: res.data };
      const d = res.data;
      const dn = (d.displayName as { text?: string } | undefined)?.text ?? place.name;
      const ptype = (d.primaryTypeDisplayName as { text?: string } | undefined)?.text ?? '—';
      markWorkItem(JOB_NAME, placeId, 'success', {
        attempts, rootKey: place.cid, parentKey: place.cid, parentJob: 'cid-to-place-id-resolver',
        detail: { name: dn, rating: d.rating ?? null, type: ptype, address: d.formattedAddress ?? null },
      });
      okCount++;
      ctx.log(`[${i + 1}] ENRICHED "${dn}"`);
      ctx.log(`      place_id: ${placeId}`);
      ctx.log(`      rating:   ${d.rating ?? '—'} (${d.userRatingCount ?? 0} reviews)`);
      ctx.log(`      type:     ${ptype}`);
      ctx.log(`      price:    ${d.priceLevel ?? '—'}`);
      ctx.log(`      address:  ${d.formattedAddress ?? '—'}`);
      ctx.log(`      spend:    ${usedMonth}/${monthCap} month · ${usedToday}/${dayCap} today (google-places service)`);
      consecutiveFails = 0;
    } else {
      enriched[place.cid] = { cid: place.cid, placeId, status: 'failed', enrichedAt: new Date().toISOString(), attempts, error: res.error };
      markWorkItem(JOB_NAME, placeId, 'failed', { attempts, rootKey: place.cid, parentKey: place.cid, parentJob: 'cid-to-place-id-resolver', detail: { name: place.name, error: res.error } });
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
  ctx.log(`Spend used:           ${usedMonth}/${monthCap} month · ${usedToday}/${dayCap} today (google-places service)`);
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
