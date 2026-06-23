import type { JobContext } from '../../../core/types.js';
import { getWorkItem, isWorkItemDone, markWorkItem } from '../../../db/store.js';
import { runClaude } from '../claude.js';
import { perfumesConfig } from '../config.js';
import { ensureDirs, label, loadPerfumes, readJsonFile, reportItemProgress, writeJsonFile } from '../lib.js';
import type { PerfumeInput, StageResult } from '../types.js';

export const FIND_JOB = 'perfumes-find-url';

/** Stage 1: ask Claude (web) to find each perfume's Fragrantica URL. */
export async function runFindUrl(ctx: JobContext): Promise<StageResult> {
  ensureDirs();
  const perfumes = loadPerfumes();
  const urls = readJsonFile<Record<string, string>>(perfumesConfig.urlsFile, {});
  const todo = perfumes.filter((p) => ctx.rootAllowed(p.id) && !isWorkItemDone(FIND_JOB, p.id, perfumesConfig.maxAttempts));
  ctx.log(`[find-url] ${perfumes.length} perfumes · ${todo.length} still need a Fragrantica URL`);

  let ok = 0;
  let failed = 0;
  let rateLimited = false;
  const cap = perfumesConfig.runLimit > 0 ? perfumesConfig.runLimit : Infinity;
  const total = Math.min(todo.length, cap); // how many we'll actually attempt this run (progress denominator)

  for (const [i, p] of todo.entries()) {
    if (ok + failed >= cap) break;
    ctx.log(`[find-url] ${i + 1}/${total} → ${label(p)}`);
    const attempts = (getWorkItem(FIND_JOB, p.id)?.attempts ?? 0) + 1;
    const res = perfumesConfig.dryRun
      ? { ok: true, text: `https://www.fragrantica.com/perfume/${encodeURIComponent(p.brand)}/${encodeURIComponent(p.name)}-0.html`, rateLimited: false }
      : await runClaude(findPrompt(p), perfumesConfig.modelFind);

    if (res.rateLimited) { ctx.log('[find-url] Claude usage/rate limit — pausing stage; will resume.', 'warn'); rateLimited = true; break; }

    const url = (res.text || '').trim().split(/\s+/)[0] ?? '';
    if (res.ok && /^https:\/\/www\.fragrantica\.com\/perfume\//i.test(url)) {
      urls[p.id] = url;
      writeJsonFile(perfumesConfig.urlsFile, urls);
      markWorkItem(FIND_JOB, p.id, 'success', { attempts, detail: { name: label(p), url } });
      ok++;
      ctx.log(`[find-url] ✓ ${label(p)} → ${url}`);
    } else {
      const reason = !res.ok
        ? (res.error ?? 'claude error')
        : /^none$/i.test(res.text.trim()) ? 'no Fragrantica page found' : `unexpected reply: ${res.text.slice(0, 80)}`;
      markWorkItem(FIND_JOB, p.id, 'failed', { attempts, detail: { name: label(p), error: reason } });
      failed++;
      ctx.log(`[find-url] ✗ ${label(p)}: ${reason}${attempts >= perfumesConfig.maxAttempts ? ' — giving up' : ''}`, 'warn');
    }
    reportItemProgress(ctx, i + 1, total, `${ok} ok, ${failed} failed`);
  }

  const pending = perfumes.filter((p) => !isWorkItemDone(FIND_JOB, p.id, perfumesConfig.maxAttempts)).length;
  return { ok, failed, pending, rateLimited };
}

function findPrompt(p: PerfumeInput): string {
  return [
    'Find the exact Fragrantica page URL for this perfume:',
    `  Name: ${p.name}`,
    `  Concentration: ${p.concentration}`,
    `  House / Brand: ${p.brand}`,
    '',
    'Use web search. A Fragrantica perfume URL looks like:',
    '  https://www.fragrantica.com/perfume/<Brand>/<Name>-<number>.html',
    `If the perfume exists in several concentrations, choose the page matching "${p.concentration}".`,
    'Be careful to match the exact house and name (niche houses have similarly-named fragrances).',
    '',
    'Reply with ONLY the single URL, on one line — no markdown, no quotes, no commentary.',
    'If you genuinely cannot find a Fragrantica page for it, reply with exactly: NONE',
  ].join('\n');
}
