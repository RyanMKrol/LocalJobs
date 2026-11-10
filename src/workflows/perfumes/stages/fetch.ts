import { join } from 'node:path';
import type { BrowserContext } from 'playwright';
import { FatalStageError, ItemFailure, eachItem, type ItemTally, type JobContext } from '../../../engine/index.js';
import { launchPersistentBrowser } from '../../../core/browser.js';
import { callService } from '../../../core/services.js';
import { perfumesConfig } from '../config.js';
import { ensureDirs, label, loadPerfumes, readJsonFile, writeFileAtomic } from '../lib.js';
import { FIND_JOB } from './find-url.js';

export const FETCH_JOB = 'perfumes-fetch';

interface FetchOutcome {
  text: string;
  html: string;
  title: string;
  finalUrl: string;
  status: number | null;
}

export interface FetchOpts {
  /** The id → URL map to fetch from (the stage's `urls` input). Defaults to the URL store on disk. */
  urls?: Record<string, string>;
}

/** Stage 2: headless browser loads each Fragrantica URL, scrolls to trigger the
 *  lazy performance widgets, and captures the full page text. On a short/blocked
 *  page it saves the raw HTML + diagnostics so we can see exactly what happened. */
export async function runFetch(ctx: JobContext, opts: FetchOpts = {}): Promise<ItemTally> {
  ensureDirs();
  const perfumes = await loadPerfumes();
  const urls = opts.urls ?? readJsonFile<Record<string, string>>(perfumesConfig.urlsFile, {});
  const withUrl = perfumes.filter((p) => urls[p.id]);
  ctx.log(`[fetch] ${withUrl.length} of ${perfumes.length} perfume(s) have a URL`);

  // The browser is launched on the first page actually fetched, so a run with
  // nothing to do never opens Chrome.
  const browser: { context: BrowserContext | null } = { context: null };
  try {
    return await eachItem(
      ctx,
      FETCH_JOB,
      withUrl,
      { key: (p) => p.id, title: label, from: { job: FIND_JOB }, maxAttempts: perfumesConfig.maxAttempts, limit: perfumesConfig.runLimit },
      async (p) => {
        if (!browser.context) {
          ctx.log(`[fetch] launching ${perfumesConfig.fetchHeadless ? 'headless' : 'headed'} ${perfumesConfig.fetchChannel || 'chromium'} (persistent profile) · ${perfumesConfig.fetchDelayMs}–${perfumesConfig.fetchDelayMs + perfumesConfig.fetchJitterMs}ms between pages`);
          try {
            browser.context = await launchContext(ctx);
          } catch (e) {
            // Not this perfume's fault, and no other perfume would fare better.
            throw new FatalStageError(`could not launch the browser: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
          }
        }
        const context = browser.context;
        // Pacing is the 'fragrantica' service's job (min-interval + jitter).
        const o = await callService('fragrantica', () => fetchPage(context, urls[p.id]), {
          onThrottle: (ms) => ctx.log(`[fetch] waited ${Math.round(ms / 1000)}s for fragrantica spacing`),
        });
        const words = p.name.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
        const lc = o.text.toLowerCase();
        const matched = words.length === 0 || words.some((w) => lc.includes(w));
        const blocked = /just a moment|attention required|cf-|checking your browser|enable javascript/i.test(o.title + ' ' + o.text.slice(0, 400));

        if (o.text.length >= 600 && matched && !blocked) {
          const path = join(perfumesConfig.pagesDir, `${p.id}.txt`);
          // The raw HTML is kept alongside the text: the accord-bar widths (each
          // accord's strength %) live in inline `width: NN%` styles that innerText
          // drops, so the parse stage reads them back from this .html (T072). It is
          // written first, so the .txt the parse stage looks for never exists
          // without it.
          writeFileAtomic(join(perfumesConfig.pagesDir, `${p.id}.html`), o.html);
          writeFileAtomic(path, o.text);
          ctx.log(`  captured ${o.text.length} chars, ${o.html.length} html bytes`);
          return { format: 'text', path, textLength: o.text.length, htmlBytes: o.html.length, url: urls[p.id] };
        }

        // Save the offending page so we can see exactly what Fragrantica returned.
        const debugFile = join(perfumesConfig.pagesFailedDir, `${p.id}.html`);
        writeFileAtomic(debugFile, o.html);
        writeFileAtomic(join(perfumesConfig.pagesFailedDir, `${p.id}.txt`), o.text);
        const why = blocked ? 'cloudflare challenge / bot block'
          : o.text.length < 600 ? `page too short (${o.text.length} chars)`
          : 'page text did not mention the perfume name';
        ctx.log(`  title="${o.title}" · ${o.text.length} chars · saved ${debugFile}`, 'warn');
        throw new ItemFailure(why, {
          httpStatus: o.status,
          pageTitle: o.title,
          finalUrl: o.finalUrl,
          textLength: o.text.length,
          snippet: o.text.replace(/\s+/g, ' ').trim().slice(0, 160),
          debugFile,
          url: urls[p.id],
        });
      },
    );
  } finally {
    await browser.context?.close();
  }
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
