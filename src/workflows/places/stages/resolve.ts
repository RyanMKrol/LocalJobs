import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { type BrowserContext, chromium } from 'playwright';
import type { JobContext } from '../../../core/types.js';
import { capStatus, getWorkItem, isWorkItemDone, markWorkItem, recordUsage, workItemCounts } from '../../../db/store.js';
import { placesConfig, resolveConfig } from '../config.js';
import { extractFeatureId } from '../parse.js';
import type { IngestOutput, ResolvedFile, ResolvedPlace } from '../types.js';

const JOB_NAME = 'cid-to-place-id-resolver';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The originating-input keys for the places workflow (T094): every saved place's
 * CID from the ingest output (places.json). Used by a manual run-limit to select
 * the first N roots. Guarded — returns [] if places.json isn't present yet (the
 * limit then selects nothing; run ingest first, or run unlimited).
 */
export function resolveInputKeys(): string[] {
  try {
    if (!existsSync(placesConfig.placesOut)) return [];
    const ingest = JSON.parse(readFileSync(placesConfig.placesOut, 'utf8')) as IngestOutput;
    return ingest.places.filter((p) => p.cid).map((p) => p.cid!);
  } catch {
    return [];
  }
}

/**
 * Resolve each saved place's CID to a Google place_id (+ coords/featureId/kgMid)
 * by loading the headless Maps page and reading the place_id out of its network
 * responses. Resumable: already-resolved CIDs are skipped and progress is
 * persisted to resolved.json as it goes.
 */
export async function runResolve(ctx: JobContext): Promise<ResolvedFile> {
  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log('cid-to-place-id-resolver starting');

  if (!existsSync(placesConfig.placesOut)) {
    throw new Error(`places.json not found at ${placesConfig.placesOut} — run places-ingest first`);
  }
  const ingest = JSON.parse(readFileSync(placesConfig.placesOut, 'utf8')) as IngestOutput;
  const resolvable = ingest.places.filter((p) => p.cid);
  ctx.log(`Loaded ${ingest.places.length} places (${resolvable.length} have a CID and can be resolved)`);

  // Load prior progress (resumability).
  const resolved: Record<string, ResolvedPlace> = existsSync(placesConfig.resolvedOut)
    ? (JSON.parse(readFileSync(placesConfig.resolvedOut, 'utf8')) as ResolvedFile).resolved
    : {};
  const ledger = workItemCounts(JOB_NAME);
  const cap0 = capStatus(JOB_NAME, resolveConfig.dailyCap, resolveConfig.monthlyCap);
  ctx.log(`Ledger so far: ${JSON.stringify(ledger)} · usage today ${cap0.today}/${resolveConfig.dailyCap}, month ${cap0.month}/${resolveConfig.monthlyCap}`);
  ctx.log('Per place we log: input CID, resolved place_id (the Places API id), coordinates (lat/lng), feature ID, KG MID, status.');
  ctx.log(`Failures (incl. timeouts) ARE retried on re-run, until they succeed or reach ${resolveConfig.maxAttempts} attempts.`);

  // Idempotency via the work_items ledger, keyed by CID (resolved.json holds the
  // payload). A manual run-limit (T094) also filters to the selected roots — for
  // places the root IS the cid (markWorkItem rule 3 keys root_key=cid here).
  let todo = resolvable.filter((p) => ctx.rootAllowed(p.cid!) && !isWorkItemDone(JOB_NAME, p.cid!, resolveConfig.maxAttempts));
  ctx.log(`To resolve this run: ${todo.length} (new places + retryable past failures)`);
  if (resolveConfig.limit > 0 && todo.length > resolveConfig.limit) {
    todo = todo.slice(0, resolveConfig.limit);
    ctx.log(`PLACES_RESOLVE_LIMIT=${resolveConfig.limit} — capping this run to ${todo.length}`, 'warn');
  }

  if (todo.length === 0) {
    ctx.progress(100, 'nothing to do — all CIDs already resolved');
    ctx.log('Nothing to resolve — all CIDs already resolved. Done.');
    return persist(resolved);
  }
  if (!cap0.allowed) {
    ctx.log(`Usage cap already reached — ${cap0.reason}. Re-run later.`, 'warn');
    return persist(resolved);
  }

  ctx.log(`Launching headless chromium (delay ${resolveConfig.delayMs}ms between lookups)…`);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'en-GB',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  });
  await context.addCookies([
    { name: 'SOCS', value: 'CAISEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiA_LyaBg', domain: '.google.com', path: '/' },
    { name: 'CONSENT', value: 'YES+cb', domain: '.google.com', path: '/' },
  ]);

  const counts = { success: 0, mismatch: 0, no_place_id: 0, error: 0 };
  let usedToday = cap0.today;
  let usedMonth = cap0.month;
  try {
    for (let i = 0; i < todo.length; i++) {
      if (usedMonth >= resolveConfig.monthlyCap || usedToday >= resolveConfig.dailyCap) {
        ctx.log(`Usage cap reached (today ${usedToday}/${resolveConfig.dailyCap}, month ${usedMonth}/${resolveConfig.monthlyCap}) — stopping; next run resumes.`, 'warn');
        break;
      }
      const place = todo[i];
      const priorAttempts = getWorkItem(JOB_NAME, place.cid!)?.attempts ?? 0;
      const rec = await resolveOne(context, place.cid!, place.name, priorAttempts);
      resolved[place.cid!] = rec;
      recordUsage(JOB_NAME);
      usedToday++; usedMonth++;
      markWorkItem(JOB_NAME, place.cid!, rec.status === 'success' ? 'success' : 'failed', {
        attempts: rec.attempts,
        detail: rec.status === 'success'
          ? { name: place.name, placeId: rec.placeId }
          : { name: place.name, status: rec.status, error: rec.error },
      });
      counts[rec.status]++;

      const ok = rec.status === 'success';
      const level = ok ? 'info' : 'warn';
      ctx.log(`[${i + 1}/${todo.length}] ${ok ? 'RESOLVED' : 'COULD NOT RESOLVE'} "${place.name}"`, level);
      ctx.log(`      input CID:    ${place.cid}  (the saved-place anchor we're resolving)`);
      ctx.log(`      place_id:     ${rec.placeId ?? '(none)'}  (the Google Places API id)`, level);
      if (rec.lat != null) ctx.log(`      coordinates:  lat ${rec.lat}, lng ${rec.lng}`);
      if (rec.featureId) ctx.log(`      feature ID:   ${rec.featureId}  (CID half ${ok ? 'matches input ✓' : 'CHECK'})`);
      if (rec.kgMid) ctx.log(`      KG MID:       ${rec.kgMid}  (Knowledge Graph id)`);
      const attemptNote = ok
        ? ''
        : ` (attempt ${rec.attempts} of ${resolveConfig.maxAttempts}${rec.attempts >= resolveConfig.maxAttempts ? ' — giving up' : '; will retry next run'})`;
      ctx.log(`      status:       ${rec.status}${attemptNote}${rec.error ? ` — ${rec.error}` : ''}`, level);

      // Persist periodically so a crash/kill never loses much progress.
      if ((i + 1) % 10 === 0) {
        persist(resolved);
        ctx.log(`  …checkpoint saved (${i + 1}/${todo.length})`);
      }
      ctx.progress(((i + 1) / todo.length) * 100, `Resolved ${i + 1}/${todo.length}`);
      if (i < todo.length - 1) await sleep(resolveConfig.delayMs);
    }
  } finally {
    await browser.close();
  }

  ctx.progress(100, `resolved ${counts.success}, failed ${counts.mismatch + counts.no_place_id + counts.error}`);
  const file = persist(resolved);
  const totalSuccess = Object.values(resolved).filter((r) => r.status === 'success').length;
  const stuck = Object.values(resolved).filter(
    (r) => r.status !== 'success' && r.attempts >= resolveConfig.maxAttempts,
  ).length;
  const remaining = resolvable.length - totalSuccess - stuck;
  ctx.log('');
  ctx.log('═══════════════ RESOLVER SUMMARY ═══════════════');
  ctx.log(`This run attempted:   ${todo.length}`);
  ctx.log(`  ✓ success:          ${counts.success}`);
  ctx.log(`  ✗ mismatch:         ${counts.mismatch}`, counts.mismatch ? 'warn' : 'info');
  ctx.log(`  ✗ no place_id:      ${counts.no_place_id}`, counts.no_place_id ? 'warn' : 'info');
  ctx.log(`  ✗ error/timeout:    ${counts.error}`, counts.error ? 'warn' : 'info');
  ctx.log(`Overall progress:     ${totalSuccess}/${resolvable.length} resolved`);
  ctx.log(`  • gave up (>=${resolveConfig.maxAttempts} attempts):  ${stuck}`, stuck ? 'warn' : 'info');
  ctx.log(`  • still to do (retry next run): ${remaining}`);
  ctx.log(`Wrote ${placesConfig.resolvedOut}`);
  ctx.log('═════════════════════════════════════════════════');

  const failedThisRun = counts.mismatch + counts.no_place_id + counts.error;
  if (failedThisRun > 0) {
    throw new Error(`${failedThisRun}/${todo.length} place(s) failed to resolve this run — see logs above`);
  }
  return file;
}

/** Resolve a single CID by loading its Maps page and reading the place_id. */
async function resolveOne(
  context: BrowserContext,
  cid: string,
  name: string,
  priorAttempts: number,
): Promise<ResolvedPlace> {
  const base: ResolvedPlace = {
    cid, name, status: 'error', placeId: null, lat: null, lng: null,
    featureId: null, kgMid: null, resolvedAt: new Date().toISOString(),
    attempts: priorAttempts + 1,
  };

  const page = await context.newPage();
  const placeIds = new Set<string>();
  page.on('response', async (res) => {
    if (placeIds.size > 0) return; // first hit is enough
    try {
      const body = await res.text();
      for (const m of body.match(/ChIJ[A-Za-z0-9_-]{20,}/g) ?? []) placeIds.add(m);
    } catch {
      /* opaque/binary response */
    }
  });

  try {
    await page.goto(`https://www.google.com/maps?cid=${cid}`, {
      waitUntil: 'domcontentloaded',
      timeout: resolveConfig.pageTimeoutMs,
    });
    // Wait for the client-side rewrite to the canonical place URL with coords.
    await page.waitForFunction(
      "location.href.includes('!3d') && location.href.includes('/maps/place/')",
      { timeout: resolveConfig.pageTimeoutMs },
    );
    await page.waitForTimeout(1500); // let the place_id XHR land

    const finalUrl = page.url();
    const coords = finalUrl.match(/!3d(-?[0-9.]+)!4d(-?[0-9.]+)/);
    const fid = extractFeatureId(finalUrl);
    const kg = finalUrl.match(/!16s%2Fg%2F([0-9a-z_]+)/i);

    base.lat = coords ? Number(coords[1]) : null;
    base.lng = coords ? Number(coords[2]) : null;
    base.featureId = fid?.featureId ?? null;
    base.kgMid = kg ? `/g/${kg[1]}` : null;
    base.placeId = [...placeIds][0] ?? null;

    if (fid && fid.cid !== cid) {
      base.status = 'mismatch';
      base.error = `resolved featureId CID ${fid.cid} != input ${cid}`;
    } else if (!base.placeId) {
      base.status = 'no_place_id';
      base.error = 'no ChIJ place_id seen in network responses';
    } else {
      base.status = 'success';
    }
  } catch (err) {
    base.status = 'error';
    base.error = err instanceof Error ? err.message.split('\n')[0] : String(err);
  } finally {
    await page.close();
  }
  return base;
}

function persist(resolved: Record<string, ResolvedPlace>): ResolvedFile {
  const file: ResolvedFile = { generatedAt: new Date().toISOString(), resolved };
  writeFileSync(placesConfig.resolvedOut, JSON.stringify(file, null, 2));
  return file;
}
