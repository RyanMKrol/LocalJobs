import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JobContext } from '../../../core/types.js';
import { getWorkItem, isWorkItemDone, markWorkItem } from '../../../db/store.js';
import { extractJson, runClaude } from '../claude.js';
import { perfumesConfig } from '../config.js';
import { ensureDirs, label, loadPerfumes, reportItemProgress } from '../lib.js';
import type { Accord, PerfumeInput, StageResult } from '../types.js';

export const PARSE_JOB = 'perfumes-parse';

/** Stage 3: Claude reads the captured page text and extracts structured JSON. */
export async function runParse(ctx: JobContext): Promise<StageResult> {
  ensureDirs();
  const perfumes = await loadPerfumes();
  const pagePath = (id: string) => join(perfumesConfig.pagesDir, `${id}.txt`);
  const pendingOf = () => perfumes.filter((p) => ctx.rootAllowed(p.id) && existsSync(pagePath(p.id)) && !isWorkItemDone(PARSE_JOB, p.id, perfumesConfig.maxAttempts));
  const todo = pendingOf();
  ctx.log(`[parse] ${todo.length} page(s) to parse into structured JSON`);

  let ok = 0;
  let failed = 0;
  let rateLimited = false;
  const cap = perfumesConfig.runLimit > 0 ? perfumesConfig.runLimit : Infinity;
  const total = Math.min(todo.length, cap); // how many we'll actually parse this run (progress denominator)

  for (const [i, p] of todo.entries()) {
    if (ok + failed >= cap) break;
    ctx.log(`[parse] ${i + 1}/${total} → ${label(p)}`);
    const attempts = (getWorkItem(PARSE_JOB, p.id)?.attempts ?? 0) + 1;
    const pageText = readFileSync(pagePath(p.id), 'utf8');
    const res = perfumesConfig.dryRun
      ? { ok: true, text: JSON.stringify({ dryRun: true, name: p.name }), rateLimited: false }
      : await runClaude(parsePrompt(p, pageText), perfumesConfig.modelParse);

    if (res.rateLimited) { ctx.log('[parse] Claude usage/rate limit — pausing stage; will resume.', 'warn'); rateLimited = true; break; }

    try {
      if (!res.ok) throw new Error(res.error ?? 'claude error');
      const data = extractJson(res.text);
      applyAccordPercents(data, p.id, ctx);
      applyNormalizedNotes(data, label(p), ctx);
      writeFileSync(join(perfumesConfig.fragranticaDir, `${p.id}.json`), JSON.stringify(data, null, 2));
      markWorkItem(PARSE_JOB, p.id, 'success', { attempts, detail: { name: label(p) } });
      ok++;
      ctx.log(`[parse] ✓ ${label(p)}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message.split('\n')[0] : String(e);
      markWorkItem(PARSE_JOB, p.id, 'failed', { attempts, detail: { name: label(p), error: msg } });
      failed++;
      ctx.log(`[parse] ✗ ${label(p)}: ${msg}${attempts >= perfumesConfig.maxAttempts ? ' — giving up' : ''}`, 'warn');
    }
    reportItemProgress(ctx, i + 1, total, `${ok} ok, ${failed} failed`);
  }

  return { ok, failed, pending: pendingOf().length, rateLimited };
}

function parsePrompt(p: PerfumeInput, pageText: string): string {
  return [
    `Below is the full captured text of the Fragrantica page for "${p.name}" (${p.concentration}) by ${p.brand}.`,
    'Extract the community data into a single JSON object with EXACTLY these keys (use null or [] when the page does not show something — never invent numbers):',
    '{',
    '  "name": string,                       // perfume name as shown on the page',
    '  "brand": string,',
    '  "accords": [{"name": string, "pct": number|null}],   // the "main accords" bars, strongest first',
    '  "notes": { "top": string[], "heart": string[], "base": string[] },  // the notes pyramid',
    '  "rating": number|null,                // aggregate rating out of 5',
    '  "votes": number|null,                 // number of rating votes',
    '  "longevity": {"very weak": number, "weak": number, "moderate": number, "long lasting": number, "eternal": number}|null,',
    '  "sillage": {"intimate": number, "moderate": number, "strong": number, "enormous": number}|null,',
    '  "gender": {"female": number, "more female": number, "unisex": number, "more male": number, "male": number}|null,',
    '  "priceValue": {"way overpriced": number, "overpriced": number, "ok": number, "good value": number, "great value": number}|null,',
    '  "whenToWear": {"winter": number, "spring": number, "summer": number, "fall": number, "day": number, "night": number}|null,',
    '  "reviewThemes": string                // 2-4 sentence summary of what reviewers/commenters actually say (suitability, compliments, complaints); null if no reviews shown',
    '}',
    '',
    'The voting widgets appear as a label followed by a vote count (e.g. "moderate 485"). Use those exact counts.',
    'Reply with ONLY the JSON object — no markdown fences, no commentary.',
    '',
    '--- FRAGRANTICA PAGE TEXT ---',
    pageText.slice(0, 24000),
  ].join('\n');
}

/**
 * Pull the "main accords" bar strengths out of a cached Fragrantica page's HTML.
 *
 * Fragrantica renders each accord as a coloured bar — a `<div>` whose inline
 * `width: NN%` style IS the accord's relative strength (the strongest accord is
 * 100%) — wrapping a `<span class="truncate">NAME</span>`. The captured page
 * *text* drops these widths (innerText keeps only the names), so the percentages
 * have to come from the HTML. Returns the accords in page order (strongest first),
 * deduped by name. Returns `[]` when the page shows no accords block at all.
 */
export function parseAccordPercents(html: string): Accord[] {
  const headingIdx = html.search(/main accords/i);
  if (headingIdx === -1) return [];
  // Bound the search to the accords block right after the heading so unrelated
  // width-styled elements elsewhere on the page can't leak in.
  const region = html.slice(headingIdx, headingIdx + 8000);
  const bar = /style="[^"]*\bwidth:\s*([\d.]+)%[^"]*"[^>]*>\s*<span[^>]*class="[^"]*\btruncate\b[^"]*"[^>]*>([^<]+)<\/span>/gi;
  const out: Accord[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = bar.exec(region)) !== null) {
    const pct = Math.round(Number(m[1]));
    const name = m[2].replace(/\s+/g, ' ').trim().toLowerCase();
    if (!name || seen.has(name) || !Number.isFinite(pct)) continue;
    seen.add(name);
    out.push({ name, pct });
  }
  return out;
}

/** The Fragrantica notes pyramid: one `string[]` per tier. An empty tier means
 *  the page simply showed no notes for it — recorded as `[]`, never as a guess. */
export interface NotesPyramid {
  top: string[];
  heart: string[];
  base: string[];
}

/**
 * Coerce a parsed `notes` value into a canonical pyramid. Every tier is always
 * present as an array (a missing / null / non-array tier becomes `[]`); each
 * entry is a whitespace-collapsed, non-empty string. A pyramid that came back
 * empty stays *explicitly* empty — Fragrantica genuinely showed no notes
 * breakdown — so downstream can mark it honestly rather than fabricate one.
 */
export function normalizeNotes(raw: unknown): NotesPyramid {
  const tier = (v: unknown): string[] =>
    Array.isArray(v)
      ? v
          .map((x) => (typeof x === 'string' ? x.replace(/\s+/g, ' ').trim() : ''))
          .filter((s) => s.length > 0)
      : [];
  const n = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { top: tier(n.top), heart: tier(n.heart), base: tier(n.base) };
}

/** True when the notes pyramid has nothing in any tier — i.e. the page showed
 *  no notes breakdown at all for this perfume. */
export function notesEmpty(n: NotesPyramid): boolean {
  return n.top.length === 0 && n.heart.length === 0 && n.base.length === 0;
}

/** Replace the parsed `notes` with its canonical pyramid in place, and log
 *  whether the page actually carried a notes breakdown. An empty pyramid is
 *  written back as `{ top: [], heart: [], base: [] }` — present but explicitly
 *  empty — so the build stage never silently drops it or invents notes. */
function applyNormalizedNotes(data: unknown, name: string, ctx: JobContext): void {
  if (!data || typeof data !== 'object') return;
  const notes = normalizeNotes((data as { notes?: unknown }).notes);
  (data as { notes: NotesPyramid }).notes = notes;
  if (notesEmpty(notes)) {
    ctx.log(`[parse]   ${name}: Fragrantica notes pyramid empty — recorded as empty (not fabricated)`, 'warn');
  } else {
    ctx.log(`[parse]   ${name}: notes ${notes.top.length}/${notes.heart.length}/${notes.base.length} (top/heart/base)`);
  }
}

/** Locate the cached HTML for a page, if any was kept (the success path saves
 *  only `.txt`; a `.html` shows up for pages the fetch stage diagnosed). */
function readPageHtml(id: string): string | null {
  for (const path of [
    join(perfumesConfig.pagesDir, `${id}.html`),
    join(perfumesConfig.pagesFailedDir, `${id}.html`),
  ]) {
    if (existsSync(path)) return readFileSync(path, 'utf8');
  }
  return null;
}

/**
 * Fill in each accord's `pct` from the cached page HTML's bar widths, matching by
 * (lowercased) accord name. Claude gives us the accord *names* (and everything
 * else) from the page text; this adds the *weight* the text can't carry. An
 * accord with no matching bar — or a page with no cached HTML — keeps `pct: null`
 * so a genuine absence is never papered over with a fake number.
 */
function applyAccordPercents(data: unknown, id: string, ctx: JobContext): void {
  if (!data || typeof data !== 'object') return;
  const accords = (data as { accords?: unknown }).accords;
  if (!Array.isArray(accords) || accords.length === 0) return;

  const html = readPageHtml(id);
  if (!html) {
    ctx.log(`[parse]   no cached HTML for ${id} — accord percentages left null`, 'warn');
    return;
  }
  const bars = parseAccordPercents(html);
  if (bars.length === 0) {
    ctx.log(`[parse]   no accord bars found in cached HTML for ${id} — percentages left null`, 'warn');
    return;
  }
  const byName = new Map(bars.map((b) => [b.name, b.pct]));

  let filled = 0;
  for (const a of accords) {
    if (!a || typeof a !== 'object' || typeof (a as Accord).name !== 'string') continue;
    const pct = byName.get((a as Accord).name.replace(/\s+/g, ' ').trim().toLowerCase());
    (a as Accord).pct = pct ?? null;
    if (pct != null) filled++;
  }
  ctx.log(`[parse]   accord percentages: filled ${filled}/${accords.length} from bar widths (${bars.length} bar${bars.length === 1 ? '' : 's'} parsed)`);
}
