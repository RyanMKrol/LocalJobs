import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GoogleGenAI } from '@google/genai';
import type { JobContext } from '../../../core/types.js';
import { getWorkItem, isWorkItemDone, markWorkItem, serviceCallsThisMonth, serviceCallsToday, workItemCounts } from '../../../db/store.js';
import { QuotaExceededError, callService, getServiceDef } from '../../../core/services.js';
import { llmConfig, placesConfig } from '../config.js';
import type { EnrichedFile, EnrichedPlace } from '../types.js';

/** The unit-of-work key space in the work_items ledger. */
const JOB_NAME = 'enrich-with-llm';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A quota / rate / depleted-credits error — treat as a graceful stop, not a per-place failure. */
function isRateLimited(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /\b429\b|resource_exhausted|rate.?limit|too many requests|quota|credits? (are )?depleted|exceeded/.test(m);
}

/** The LLM's structured verdict about a place. */
interface LlmResult {
  editorial: string;
  placeType: string;
  cuisine: string[];
  drinks: string[];
  vibe: string;
  priceBand: string;
  seasonal: boolean | null;
  goodFor: string[];
  knownFor: string;
  confidence: string; // high | medium | low — did we identify the exact place?
}

/**
 * Enrich each Google-enriched place with an LLM (Gemini) that researches it via
 * Google Search grounding + fetching the place's own website, then writes a
 * second-brain record + markdown.
 *
 * IDEMPOTENT BY place_id: every place's outcome is recorded in the `work_items`
 * ledger keyed by (JOB_NAME, place_id). A place that's already succeeded — or has
 * exhausted its retries — is skipped, so we never re-spend an LLM call on it.
 */
export async function runLlmEnrich(ctx: JobContext): Promise<void> {
  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log(`enrich-with-llm starting (model: ${llmConfig.model})`);
  if (llmConfig.dryRun) ctx.log('DRY RUN — no Gemini calls, fabricated results.', 'warn');
  if (!llmConfig.apiKey && !llmConfig.dryRun) {
    throw new Error('GEMINI_API_KEY is not set. Add it to .env (see README — places workflow).');
  }
  if (!existsSync(placesConfig.enrichedOut)) {
    throw new Error(`enriched.json not found — run places-enrich first (${placesConfig.enrichedOut})`);
  }

  const enriched = (JSON.parse(readFileSync(placesConfig.enrichedOut, 'utf8')) as EnrichedFile).enriched;
  const candidates = Object.values(enriched).filter((e) => e.status === 'success' && e.placeId);
  ctx.log(`Google-enriched places available: ${candidates.length}`);

  // Idempotency: skip place_ids already done (success, or failed past retry budget).
  // A manual run-limit (T094) also filters to the selected roots — the root is the
  // originating CID this place descends from.
  // Split exclusion reasons (T163): `notDone` = enriched places still needing an
  // LLM pass; `todo` = those within the run's selected roots (no-op when unlimited).
  const notDone = candidates.filter((p) => !isWorkItemDone(JOB_NAME, p.placeId, llmConfig.maxAttempts));
  const todo = notDone.filter((p) => ctx.rootAllowed(p.cid));
  const ledger = workItemCounts(JOB_NAME);
  ctx.log(`Ledger so far: ${JSON.stringify(ledger)}`);
  ctx.log(`To process this run: ${todo.length} (place_ids not yet done)`);
  ctx.log('Each place is keyed by place_id in the work_items table — re-runs skip completed ones.');

  if (todo.length === 0) {
    if (notDone.length > 0) {
      // Limited run: outstanding LLM work exists, just none in the selected roots.
      ctx.progress(100, `0 to do this run — ${notDone.length} outstanding but none in this run's selected roots`);
      ctx.log(`0 to LLM-enrich this run — ${notDone.length} place(s) still need decorating, but none fall within this limited run's selected roots. Re-run unlimited (or with a higher limit) to drain them. ✓`, 'warn');
    } else {
      ctx.progress(100, 'nothing to do — every enriched place already decorated');
      ctx.log('Nothing to do — every place is already LLM-enriched. ✓');
    }
    return;
  }

  // Load the payload store (the actual rich output) + ensure markdown dir.
  const store: Record<string, { placeId: string; cid: string; name: string; result: LlmResult; at: string }> =
    existsSync(placesConfig.llmOut) ? JSON.parse(readFileSync(placesConfig.llmOut, 'utf8')) : {};
  mkdirSync(placesConfig.markdownDir, { recursive: true });

  // Your own lists + notes from the ingest output, keyed by cid. These go into the
  // markdown ONLY (provenance + personal context) — NOT into the LLM prompt.
  const placesMeta: Record<string, PlaceMeta> = {};
  if (existsSync(placesConfig.placesOut)) {
    for (const p of (JSON.parse(readFileSync(placesConfig.placesOut, 'utf8')).places ?? [])) {
      placesMeta[p.cid] = { lists: p.lists ?? [], notes: p.notes ?? [] };
    }
  }
  ctx.log(`Loaded your lists/notes for ${Object.keys(placesMeta).length} places (markdown provenance only).`);

  const perRunCap = llmConfig.runLimit > 0 ? llmConfig.runLimit : Infinity;
  const ai = llmConfig.dryRun ? null : new GoogleGenAI({ apiKey: llmConfig.apiKey });

  // Spend is governed SOLELY by the shared 'gemini' service quota (enforced inside
  // callService, which throws QuotaExceededError when exhausted) — read it here
  // just for visibility.
  const svc = getServiceDef('gemini');
  ctx.log(`Service quota (gemini) — today: ${serviceCallsToday('gemini')}/${svc?.dailyCap ?? '∞'}, month: ${serviceCallsThisMonth('gemini')}/${svc?.monthlyCap ?? '∞'}`);

  let ok = 0;
  let fail = 0;
  for (let i = 0; i < todo.length; i++) {
    if (ok + fail >= perRunCap) {
      ctx.log(`Reached per-run limit of ${llmConfig.runLimit} — stopping; next run continues.`);
      break;
    }
    // Day/month spend is enforced by the 'gemini' service quota inside callService
    // below (a hit quota throws QuotaExceededError → graceful stop).
    const place = todo[i];
    const attempts = (getWorkItem(JOB_NAME, place.placeId)?.attempts ?? 0) + 1;
    const name = displayName(place);

    try {
      // Route the paid Gemini call through the shared 'gemini' service (rate + quota
      // enforced across all jobs); dry-run skips it.
      // callService meters the billable Gemini call against the shared 'gemini'
      // service (the single source of quota); dry-run bypasses it.
      const result = ai ? await callService('gemini', () => researchPlace(ai, place)) : dryRunResult(place);
      store[place.placeId] = { placeId: place.placeId, cid: place.cid, name, result, at: new Date().toISOString() };
      const mdPath = writeMarkdown(place, name, result, placesMeta[place.cid]);
      markWorkItem(JOB_NAME, place.placeId, 'success', { attempts, rootKey: place.cid, parentKey: place.placeId, parentJob: 'places-enrich', detail: { name, markdown: mdPath } });
      ok++;
      ctx.log(`[${i + 1}] ✓ "${name}"  ·  place_id=${place.placeId}`);
      ctx.log(`      type: ${result.placeType} · cuisine: ${result.cuisine.join(', ') || '—'} · vibe: ${result.vibe} · confidence: ${result.confidence}`);
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        ctx.log(`gemini ${err.window} service cap reached (${err.used}/${err.cap}) — stopping gracefully; next run resumes.`, 'warn');
        // Record soft-stop: item was not attempted; use prior attempt count (no increment).
        markWorkItem(JOB_NAME, place.placeId, 'skipped', { attempts: attempts - 1, rootKey: place.cid, parentKey: place.placeId, parentJob: 'places-enrich', detail: { name } });
        break;
      }
      const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
      if (isRateLimited(err)) {
        // Quota / rate / depleted-credits — a global stop signal, NOT this place's
        // fault. Stop gracefully without marking it failed or burning an attempt;
        // the next run resumes once capacity/credits return.
        ctx.log(`Gemini quota/credit/rate limit hit on "${name}" — stopping run gracefully (place not counted). ${msg}`, 'warn');
        // Record soft-stop: item was not attempted; use prior attempt count (no increment).
        markWorkItem(JOB_NAME, place.placeId, 'skipped', { attempts: attempts - 1, rootKey: place.cid, parentKey: place.placeId, parentJob: 'places-enrich', detail: { name } });
        break;
      }
      markWorkItem(JOB_NAME, place.placeId, 'failed', { attempts, rootKey: place.cid, parentKey: place.placeId, parentJob: 'places-enrich', detail: { name, error: msg } });
      fail++;
      const note = attempts >= llmConfig.maxAttempts ? ' — giving up (max attempts)' : `; will retry (attempt ${attempts}/${llmConfig.maxAttempts})`;
      ctx.log(`[${i + 1}] ✗ "${name}" — ${msg}${note}`, 'warn');
    }

    if ((ok + fail) % 10 === 0) writeFileSync(placesConfig.llmOut, JSON.stringify(store, null, 2));
    ctx.progress((Math.min(i + 1, todo.length) / todo.length) * 100, `LLM-enriched ${ok}`);
    if (i < todo.length - 1) await sleep(llmConfig.delayMs);
  }

  writeFileSync(placesConfig.llmOut, JSON.stringify(store, null, 2));
  ctx.progress(100, `enriched ${ok}, failed ${fail}`);
  const finalLedger = workItemCounts(JOB_NAME);
  ctx.log('');
  ctx.log('═══════════════ LLM-ENRICH SUMMARY ═══════════════');
  ctx.log(`This run — enriched: ${ok}, failed: ${fail}`);
  ctx.log(`Ledger (lifetime): ${JSON.stringify(finalLedger)}`);
  ctx.log(`Overall done: ${(finalLedger.success ?? 0)}/${candidates.length}`);
  ctx.log(`Wrote ${placesConfig.llmOut} + markdown in ${placesConfig.markdownDir}`);
  ctx.log('═══════════════════════════════════════════════════');
}

/** Build the grounded research prompt and call Gemini; parse its JSON verdict. */
async function researchPlace(ai: GoogleGenAI, place: EnrichedPlace): Promise<LlmResult> {
  const prompt = buildPrompt(place);
  const response = await ai.models.generateContent({
    model: llmConfig.model,
    contents: prompt,
    config: {
      // Grounding + URL context can't be combined with strict JSON mode, so we
      // ask for JSON in the text and parse it.
      tools: [{ googleSearch: {} }, { urlContext: {} }],
      // Flash-Lite defaults to thinkingLevel "minimal" (≈ won't think), and an
      // unthinking model never *decides* to search/fetch. Raising it is what
      // makes grounding + URL-context actually fire on places it doesn't know.
      thinkingConfig: { thinkingLevel: llmConfig.thinkingLevel as never },
    },
  });
  const text = response.text ?? '';
  return parseResult(text);
}

export function buildPrompt(place: EnrichedPlace): string {
  const d = (place.data ?? {}) as Record<string, any>;
  const name = (d.displayName as any)?.text ?? '(unknown)';
  const address = d.formattedAddress ?? '';
  const website = (d.websiteUri as string) ?? '';
  return [
    `Write a factual profile of this exact place: ${name}, ${address} (google type "${(d.primaryTypeDisplayName as any)?.text ?? ''}", ${d.rating ?? '—'}★ from ${d.userRatingCount ?? 0} reviews).`,
    '',
    website
      ? `STEP 1 (required): Use your URL tool to fetch and read this website for the place's own description, menu and booking info: ${website}`
      : 'STEP 1: (no website on file)',
    '',
    `STEP 2: Search the web for reviews and opinions of "${name}, ${address}" — what real visitors say about the food/drinks, the atmosphere, what it's known for, what to order, and whether it's worth going. Use what you find to inform the profile.`,
    '',
    `STEP 3: Combine the website and the reviews you found into the profile below. Stay grounded in those sources; if you cannot confirm a detail, leave it out rather than guessing, and set confidence to "low" if the sources don't clearly describe this exact place.`,
    '',
    'Return ONLY a JSON object (no prose, no markdown fence) with these keys:',
    '  editorial   : 2-3 PARAGRAPHS describing what this place is, the food/drink, the atmosphere and crowd, and why someone would go (vivid but factual)',
    '  placeType   : one of restaurant|bar|pub|club|cafe|bakery|hole-in-the-wall|hotel|shop|attraction|other',
    '  cuisine     : array of food styles (e.g. ["Thai","small plates"]) — empty if not food',
    '  drinks      : array of drink specialities (e.g. ["natural wine","cocktails"]) — empty if not relevant',
    '  vibe        : one of mainstream|niche|special-occasion|casual|trendy',
    '  priceBand   : one of £|££|£££|££££',
    '  seasonal    : boolean or null (only open/relevant seasonally?)',
    '  goodFor     : array of occasions (e.g. ["date night","groups","solo","late night"])',
    '  knownFor    : 2-3 sentences on the signature thing(s) it is known for (dishes, drinks, atmosphere, history)',
    '  confidence  : one of high|medium|low (how sure are you this is the exact place?)',
  ].filter(Boolean).join('\n');
}

/** Extract the JSON object from the model's text (tolerating fences/prose). */
export function parseResult(text: string): LlmResult {
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`no JSON in model output: ${text.slice(0, 120)}`);
  const obj = JSON.parse(s.slice(start, end + 1)) as Partial<LlmResult>;
  return {
    editorial: obj.editorial ?? '',
    placeType: obj.placeType ?? 'other',
    cuisine: obj.cuisine ?? [],
    drinks: obj.drinks ?? [],
    vibe: obj.vibe ?? 'casual',
    priceBand: obj.priceBand ?? '',
    seasonal: obj.seasonal ?? null,
    goodFor: obj.goodFor ?? [],
    knownFor: obj.knownFor ?? '',
    confidence: obj.confidence ?? 'low',
  };
}

function dryRunResult(place: EnrichedPlace): LlmResult {
  return {
    editorial: `(dry-run) A profile for ${displayName(place)} would appear here.`,
    placeType: 'restaurant', cuisine: ['(dry-run)'], drinks: [], vibe: 'casual',
    priceBand: '££', seasonal: false, goodFor: ['(dry-run)'],
    knownFor: '(dry-run)', confidence: 'low',
  };
}

function displayName(place: EnrichedPlace): string {
  const d = (place.data ?? {}) as Record<string, any>;
  return (d.displayName as any)?.text ?? place.cid;
}

/** Google amenity booleans → friendly filter tags for the vault. */
const FEATURE_FLAGS: Array<[string, string]> = [
  ['outdoorSeating', 'outdoor-seating'], ['reservable', 'reservable'],
  ['servesCocktails', 'cocktails'], ['servesWine', 'wine'], ['servesBeer', 'beer'],
  ['servesVegetarianFood', 'veggie-friendly'], ['allowsDogs', 'dog-friendly'],
  ['goodForGroups', 'good-for-groups'], ['goodForChildren', 'kid-friendly'],
  ['liveMusic', 'live-music'], ['servesBrunch', 'brunch'], ['servesBreakfast', 'breakfast'],
  ['servesLunch', 'lunch'], ['servesDinner', 'dinner'], ['servesDessert', 'dessert'],
  ['servesCoffee', 'coffee'], ['takeout', 'takeout'], ['delivery', 'delivery'],
  ['dineIn', 'dine-in'], ['goodForWatchingSports', 'sports'], ['menuForChildren', 'kids-menu'],
];

function featureTags(d: Record<string, any>): string[] {
  const tags = FEATURE_FLAGS.filter(([k]) => d[k] === true).map(([, label]) => label);
  if (d.accessibilityOptions?.wheelchairAccessibleEntrance) tags.push('wheelchair-accessible');
  return tags;
}

function cityCountry(d: Record<string, any>): { city: string; country: string } {
  const comp = (d.addressComponents ?? []) as Array<{ longText: string; types: string[] }>;
  const find = (t: string) => comp.find((c) => c.types?.includes(t))?.longText ?? '';
  return {
    city: find('postal_town') || find('locality') || find('administrative_area_level_2'),
    country: find('country'),
  };
}

function priceRangeStr(d: Record<string, any>): string {
  const pr = d.priceRange;
  if (!pr) return '';
  const sym: Record<string, string> = { GBP: '£', EUR: '€', USD: '$' };
  const c = sym[pr.startPrice?.currencyCode ?? pr.endPrice?.currencyCode] ?? '';
  const s = pr.startPrice?.units, e = pr.endPrice?.units;
  return s && e ? `${c}${s}–${e}` : s ? `${c}${s}+` : e ? `up to ${c}${e}` : '';
}

/** YAML flow-sequence with each item quoted (handles commas inside list names). */
function yamlList(items: string[]): string {
  return `[${items.map((x) => JSON.stringify(x)).join(', ')}]`;
}

export interface PlaceMeta { lists: string[]; notes: Array<{ list: string; note: string; comment: string }> }

function writeMarkdown(place: EnrichedPlace, name: string, r: LlmResult, meta?: PlaceMeta): string {
  const d = (place.data ?? {}) as Record<string, any>;
  const { city, country } = cityCountry(d);
  const lists = meta?.lists ?? [];
  const notes = (meta?.notes ?? []).map((n) => (n.note || '').trim()).filter(Boolean);
  const hours = ((d.regularOpeningHours as any)?.weekdayDescriptions ?? []) as string[];
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || place.cid;
  const path = join(placesConfig.markdownDir, `${slug}.md`);

  const fm = [
    '---',
    `name: ${JSON.stringify(name)}`,
    `lists: ${yamlList(lists)}`,                       // ← which of YOUR lists it came from
    `placeType: ${r.placeType}`,
    `cuisine: ${yamlList(r.cuisine)}`,
    `drinks: ${yamlList(r.drinks)}`,
    `vibe: ${r.vibe}`,
    `priceBand: "${r.priceBand}"`,
    priceRangeStr(d) && `priceRange: "${priceRangeStr(d)}"`,
    d.rating != null && `rating: ${d.rating}`,
    d.userRatingCount != null && `reviewCount: ${d.userRatingCount}`,
    `status: ${d.businessStatus ?? 'UNKNOWN'}`,
    `goodFor: ${yamlList(r.goodFor)}`,
    `features: ${yamlList(featureTags(d))}`,
    `seasonal: ${r.seasonal}`,
    city && `city: ${JSON.stringify(city)}`,
    country && `country: ${JSON.stringify(country)}`,
    d.location && `lat: ${d.location.latitude}`,
    d.location && `lng: ${d.location.longitude}`,
    d.nationalPhoneNumber && `phone: ${JSON.stringify(d.nationalPhoneNumber)}`,
    `address: ${JSON.stringify(d.formattedAddress ?? '')}`,
    `website: ${JSON.stringify(d.websiteUri ?? '')}`,
    `mapsUrl: ${JSON.stringify(d.googleMapsUri ?? '')}`,
    `cid: "${place.cid}"`,                             // ← provenance: original Google CID
    `placeId: ${place.placeId}`,                       // ← provenance: resolved place_id
    `confidence: ${r.confidence}`,
    '---',
  ].filter(Boolean);

  const body: string[] = ['', `# ${name}`, '', r.editorial, '', '## Known for', '', r.knownFor];
  if (notes.length) {
    body.push('', '## Your notes');
    for (const n of notes) body.push('', `> ${n.replace(/\s*\n\s*/g, ' ')}`);
  }
  if (hours.length) {
    body.push('', '## Hours', '');
    for (const h of hours) body.push(`- ${h}`);
  }
  body.push('');

  writeFileSync(path, [...fm, ...body].join('\n'));
  return path;
}
