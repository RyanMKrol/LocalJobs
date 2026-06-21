import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BrowserContext, chromium } from 'playwright';
import type { JobContext } from '../../core/types.js';
import { getWorkItem, isWorkItemDone, markWorkItem } from '../../db/store.js';
import { callService } from '../../core/services.js';
import { perfumesConfig } from './config.js';
import { ensureDirs, label, loadPerfumes, readJsonFile } from './lib.js';
import type { StageResult } from './types.js';

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
  const perfumes = loadPerfumes();
  const urls = readJsonFile<Record<string, string>>(perfumesConfig.urlsFile, {});
  const pendingOf = () => perfumes.filter((p) => urls[p.id] && !isWorkItemDone(FETCH_JOB, p.id, perfumesConfig.maxAttempts));
  const todo = pendingOf();
  ctx.log(`[fetch] ${todo.length} page(s) to fetch (have a URL, not yet captured)`);
  if (todo.length === 0) return { ok: 0, failed: 0, pending: 0, rateLimited: false };

  ctx.log(`[fetch] launching ${perfumesConfig.fetchHeadless ? 'headless' : 'headed'} ${perfumesConfig.fetchChannel || 'chromium'} (persistent profile) · ${perfumesConfig.fetchDelayMs}–${perfumesConfig.fetchDelayMs + perfumesConfig.fetchJitterMs}ms between pages`);
  const context = await launchContext(ctx);

  let ok = 0;
  let failed = 0;
  const cap = perfumesConfig.runLimit > 0 ? perfumesConfig.runLimit : Infinity;
  try {
    for (const p of todo) {
      if (ok + failed >= cap) break;
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
        markWorkItem(FETCH_JOB, p.id, 'success', { attempts, detail: { name: label(p) } });
        ok++;
        ctx.log(`[fetch] ✓ ${label(p)} (${o.text.length} chars)`);
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
    }
  } finally {
    await context.close();
  }

  return { ok, failed, pending: pendingOf().length, rateLimited: false };
}

/** Persistent profile + real Chrome keeps Cloudflare's clearance cookie across pages
 *  and runs. Falls back to bundled chromium if real Chrome isn't installed. */
async function launchContext(ctx: JobContext): Promise<BrowserContext> {
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
  const base = {
    headless: perfumesConfig.fetchHeadless,
    viewport: { width: 1280, height: 1800 },
    userAgent: UA,
    locale: 'en-GB',
    args: ['--disable-blink-features=AutomationControlled'],
  };
  // Clear any stale single-instance locks left by a crashed run.
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try { rmSync(join(perfumesConfig.profileDir, f), { force: true }); } catch { /* ignore */ }
  }
  const channel = perfumesConfig.fetchChannel;
  try {
    return await chromium.launchPersistentContext(perfumesConfig.profileDir, channel ? { ...base, channel } : base);
  } catch (e) {
    if (!channel) throw e;
    ctx.log(`[fetch] real Chrome (channel=${channel}) unavailable (${e instanceof Error ? e.message.split('\n')[0] : e}); using bundled chromium`, 'warn');
    return await chromium.launchPersistentContext(perfumesConfig.profileDir, base);
  }
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
