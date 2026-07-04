import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright';
import type { JobContext } from '../../../core/types.js';
import { launchPersistentBrowser } from '../../../core/browser.js';
import { getWorkItem, isWorkItemDone, markWorkItem } from '../../../db/store.js';
import { callService } from '../../../core/services.js';
import { perfumesConfig } from '../config.js';
import { ensureDirs, label, loadPerfumes, readJsonFile, reportItemProgress } from '../lib.js';
import type { StageResult } from '../types.js';

export const FETCH_JOB = 'perfumes-fetch';

interface FetchOutcome {
  text: string;
  html: string;
  title: string;
  finalUrl: string;
  status: number | null;
}

/** Stage 2: headless browser loads each Fragrantica URL, scrolls to trigger the
 *  lazy performance widgets, and captures the full page text. On a short/blocked
 *  page it saves the raw HTML + diagnostics so we can see exactly what happened. */
export async function runFetch(ctx: JobContext): Promise<StageResult> {
  ensureDirs();
  const perfumes = await loadPerfumes();
  const urls = readJsonFile<Record<string, string>>(perfumesConfig.urlsFile, {});
  const pendingOf = () => perfumes.filter((p) => ctx.rootAllowed(p.id) && urls[p.id] && !isWorkItemDone(FETCH_JOB, p.id, perfumesConfig.maxAttempts));
  const todo = pendingOf();
  ctx.log(`[fetch] ${todo.length} page(s) to fetch (have a URL, not yet captured)`);
  if (todo.length === 0) return { ok: 0, failed: 0, pending: 0, rateLimited: false };

  ctx.log(`[fetch] launching ${perfumesConfig.fetchHeadless ? 'headless' : 'headed'} ${perfumesConfig.fetchChannel || 'chromium'} (persistent profile) · ${perfumesConfig.fetchDelayMs}–${perfumesConfig.fetchDelayMs + perfumesConfig.fetchJitterMs}ms between pages`);
  const context = await launchContext(ctx);

  let ok = 0;
  let failed = 0;
  const cap = perfumesConfig.runLimit > 0 ? perfumesConfig.runLimit : Infinity;
  const total = Math.min(todo.length, cap); // how many we'll actually fetch this run (progress denominator)
  try {
    for (const [i, p] of todo.entries()) {
      if (ok + failed >= cap) break;
      ctx.log(`[fetch] ${i + 1}/${total} → ${label(p)}`);
      const attempts = (getWorkItem(FETCH_JOB, p.id)?.attempts ?? 0) + 1;
      const o = await callService('fragrantica', () => fetchPage(context, urls[p.id]), {
        onThrottle: (ms) => ctx.log(`[fetch] waited ${Math.round(ms / 1000)}s for fragrantica spacing`),
      });
      const words = p.name.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
      const lc = o.text.toLowerCase();
      const matched = words.length === 0 || words.some((w) => lc.includes(w));
      const blocked = /just a moment|attention required|cf-|checking your browser|enable javascript/i.test(o.title + ' ' + o.text.slice(0, 400));

      if (o.text.length >= 600 && matched && !blocked) {
        writeFileSync(join(perfumesConfig.pagesDir, `${p.id}.txt`), o.text);
        // Persist the raw HTML alongside the text: the accord-bar widths (each
        // accord's strength %) live in inline `width: NN%` styles that innerText
        // drops, so the parse stage reads them back from this .html. Without it
        // every accord pct falls back to null (the success path used to save only
        // .txt, so pages/<id>.html never existed — T072).
        writeFileSync(join(perfumesConfig.pagesDir, `${p.id}.html`), o.html);
        markWorkItem(FETCH_JOB, p.id, 'success', { attempts, detail: { name: label(p) } });
        ok++;
        ctx.log(`[fetch] ✓ ${label(p)} (${o.text.length} chars, ${o.html.length} html bytes)`);
      } else {
        // Save the offending page so we can see exactly what Fragrantica returned.
        const debugFile = join(perfumesConfig.pagesFailedDir, `${p.id}.html`);
        writeFileSync(debugFile, o.html);
        writeFileSync(join(perfumesConfig.pagesFailedDir, `${p.id}.txt`), o.text);
        const why = blocked ? 'cloudflare challenge / bot block'
          : o.text.length < 600 ? `page too short (${o.text.length} chars)`
          : 'page text did not mention the perfume name';
        const snippet = o.text.replace(/\s+/g, ' ').trim().slice(0, 160);
        markWorkItem(FETCH_JOB, p.id, 'failed', {
          attempts,
          detail: {
            name: label(p),
            error: why,
            httpStatus: o.status,
            pageTitle: o.title,
            finalUrl: o.finalUrl,
            textLength: o.text.length,
            snippet,
            debugFile,
            url: urls[p.id],
          },
        });
        failed++;
        ctx.log(`[fetch] ✗ ${label(p)}: ${why} · title="${o.title}" · ${o.text.length} chars · saved ${debugFile}${attempts >= perfumesConfig.maxAttempts ? ' — giving up' : ''}`, 'warn');
      }
      // pacing is now handled by the 'fragrantica' service (min-interval + jitter)
      reportItemProgress(ctx, i + 1, total, `${ok} ok, ${failed} failed`);
    }
  } finally {
    await context.close();
  }

  return { ok, failed, pending: pendingOf().length, rateLimited: false };
}

/** Persistent profile + real Chrome keeps Cloudflare's clearance cookie across pages
 *  and runs. Falls back to bundled chromium if real Chrome isn't installed. The
 *  reputation-gate launch logic lives in the shared `core/browser` helper; pacing
 *  stays here (handled by the 'fragrantica' service's jittered min-interval). */
async function launchContext(ctx: JobContext): Promise<BrowserContext> {
  return launchPersistentBrowser({
    profileDir: perfumesConfig.profileDir,
    headless: perfumesConfig.fetchHeadless,
    channel: perfumesConfig.fetchChannel,
    log: (msg, level) => ctx.log(`[fetch] ${msg}`, level),
  });
}

async function fetchPage(context: BrowserContext, url: string): Promise<FetchOutcome> {
  const page = await context.newPage();
  let status: number | null = null;
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: perfumesConfig.pageTimeoutMs });
    status = resp?.status() ?? null;
    // Wait for real content — a Cloudflare interstitial has a tiny body; the real
    // page is large. Don't throw if it never arrives (we capture + diagnose below).
    await page
      .waitForFunction('document.body && document.body.innerText && document.body.innerText.length > 1500', { timeout: perfumesConfig.contentWaitMs })
      .catch(() => {});
    // Scroll the whole page so the lazy-loaded performance/voting widgets render.
    for (let i = 0; i < perfumesConfig.scrollSteps; i++) {
      await page.mouse.wheel(0, 1200);
      await page.waitForTimeout(300);
    }
    await page.waitForTimeout(1200);
    return {
      text: await page.innerText('body'),
      html: await page.content(),
      title: await page.title().catch(() => ''),
      finalUrl: page.url(),
      status,
    };
  } catch (e) {
    return { text: '', html: '', title: `(navigation error: ${e instanceof Error ? e.message.split('\n')[0] : e})`, finalUrl: url, status };
  } finally {
    await page.close();
  }
}
