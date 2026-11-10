import { existsSync } from 'node:fs';
import { eachItem, softStop, type ItemTally, type JobContext } from '../../../engine/index.js';
import { runClaude } from '../../../services/claude.js';
import { perfumesConfig } from '../config.js';
import { ensureDirs, label, loadPerfumes, readJsonFile, writeJsonFile } from '../lib.js';
import type { PerfumeInput } from '../types.js';

export const FIND_JOB = 'perfumes-find-url';

const PERFUME_PAGE = /^https:\/\/www\.fragrantica\.com\/perfume\//i;

/**
 * Stage 1: find each perfume's Fragrantica URL and add it to the URL store.
 * A perfume whose PerfumeRatings row already carries the URL is taken from
 * there (T401); the rest are looked up by Claude with web search.
 */
export async function runFindUrl(ctx: JobContext): Promise<ItemTally> {
  ensureDirs();
  const perfumes = await loadPerfumes();
  const urlsFile = perfumesConfig.urlsFile;
  const urls = readJsonFile<Record<string, string>>(urlsFile, {});
  // The store exists from the first run on, even before anything is resolved:
  // it is this stage's declared output, and "nothing yet" is a valid state of it.
  if (!existsSync(urlsFile)) writeJsonFile(urlsFile, urls);

  return eachItem(
    ctx,
    FIND_JOB,
    perfumes,
    { key: (p) => p.id, title: label, maxAttempts: perfumesConfig.maxAttempts, limit: perfumesConfig.runLimit },
    async (p) => {
      const seeded = p.fragranticaUrl && PERFUME_PAGE.test(p.fragranticaUrl) ? p.fragranticaUrl : null;
      let url = seeded;
      if (url) {
        ctx.log(`  seeded from PerfumeRatings: ${url}`);
      } else {
        const res = perfumesConfig.dryRun
          ? { ok: true, text: `https://www.fragrantica.com/perfume/${encodeURIComponent(p.brand)}/${encodeURIComponent(p.name)}-0.html`, rateLimited: false }
          : await runClaude(findPrompt(p), perfumesConfig.modelFind);
        if (res.rateLimited) return softStop('Claude usage or rate limit');
        if (!res.ok) throw new Error(res.error ?? 'claude error');
        const reply = (res.text || '').trim();
        const first = reply.split(/\s+/)[0] ?? '';
        if (!PERFUME_PAGE.test(first)) {
          throw new Error(/^none$/i.test(reply) ? 'no Fragrantica page found' : `unexpected reply: ${reply.slice(0, 80)}`);
        }
        url = first;
        ctx.log(`  found: ${url}`);
      }
      // Saved before the loop marks the perfume done, so a kill between the two
      // can never leave a "done" perfume the fetch stage has no URL for.
      urls[p.id] = url;
      writeJsonFile(urlsFile, urls);
      return seeded ? { url, seeded: true } : { url };
    },
  );
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
