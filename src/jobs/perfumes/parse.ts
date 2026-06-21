import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JobContext } from '../../core/types.js';
import { getWorkItem, isWorkItemDone, markWorkItem } from '../../db/store.js';
import { extractJson, runClaude } from './claude.js';
import { perfumesConfig } from './config.js';
import { ensureDirs, label, loadPerfumes } from './lib.js';
import type { PerfumeInput, StageResult } from './types.js';

export const PARSE_JOB = 'perfumes-parse';

/** Stage 3: Claude reads the captured page text and extracts structured JSON. */
export async function runParse(ctx: JobContext): Promise<StageResult> {
  ensureDirs();
  const perfumes = loadPerfumes();
  const pagePath = (id: string) => join(perfumesConfig.pagesDir, `${id}.txt`);
  const pendingOf = () => perfumes.filter((p) => existsSync(pagePath(p.id)) && !isWorkItemDone(PARSE_JOB, p.id, perfumesConfig.maxAttempts));
  const todo = pendingOf();
  ctx.log(`[parse] ${todo.length} page(s) to parse into structured JSON`);

  let ok = 0;
  let failed = 0;
  let rateLimited = false;
  const cap = perfumesConfig.runLimit > 0 ? perfumesConfig.runLimit : Infinity;

  for (const p of todo) {
    if (ok + failed >= cap) break;
    const attempts = (getWorkItem(PARSE_JOB, p.id)?.attempts ?? 0) + 1;
    const pageText = readFileSync(pagePath(p.id), 'utf8');
    const res = perfumesConfig.dryRun
      ? { ok: true, text: JSON.stringify({ dryRun: true, name: p.name }), rateLimited: false }
      : await runClaude(parsePrompt(p, pageText), perfumesConfig.modelParse);

    if (res.rateLimited) { ctx.log('[parse] Claude usage/rate limit — pausing stage; will resume.', 'warn'); rateLimited = true; break; }

    try {
      if (!res.ok) throw new Error(res.error ?? 'claude error');
      const data = extractJson(res.text);
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
