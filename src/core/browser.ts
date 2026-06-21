import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { type BrowserContext, chromium } from 'playwright';
import { config } from '../config.js';

/**
 * Framework-level persistent Chrome profile directory (top-level data/chrome-profile).
 * Override with `LOCALJOBS_CHROME_PROFILE`. Any job that drives a headless browser
 * should use this default so all scrapers share the same warmed, trusted profile.
 */
export const defaultChromeProfileDir: string = config.chromeProfileDir;

/** A plausible desktop-Chrome user agent — looks like an ordinary browser, not
 *  automation. Used as the default UA for the persistent-profile launcher. */
export const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** The single-instance lock files a persistent Chrome profile leaves behind; a
 *  crashed run can strand them and block the next launch, so we clear them first. */
export const PROFILE_LOCK_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'] as const;

export interface PersistentBrowserOptions {
  /** On-disk profile dir — persists cookies (e.g. a Cloudflare clearance cookie)
   *  across pages AND runs, which is what keeps a reputation-gated site happy. */
  profileDir: string;
  /** Headless by default; set false to watch the browser drive. */
  headless?: boolean;
  /** Real-Chrome channel (e.g. 'chrome'). Empty/undefined uses bundled chromium.
   *  When a channel is given but unavailable, we fall back to bundled chromium. */
  channel?: string;
  userAgent?: string;
  viewport?: { width: number; height: number };
  locale?: string;
  /** Extra launch args, appended to the anti-automation defaults. */
  args?: string[];
  /** Optional progress sink (e.g. `ctx.log`) for the chromium-fallback notice. */
  log?: (message: string, level?: 'info' | 'warn' | 'error') => void;
}

/** The shape of `chromium.launchPersistentContext`, narrowed so tests can inject
 *  a fake launcher and exercise the lock-clearing + channel-fallback logic
 *  without ever starting a real browser. */
export type PersistentLauncher = (
  profileDir: string,
  options: Record<string, unknown>,
) => Promise<BrowserContext>;

const defaultLauncher: PersistentLauncher = (dir, options) =>
  chromium.launchPersistentContext(dir, options);

/**
 * Launch a persistent-profile browser context tuned to survive Cloudflare-style
 * rate/reputation gates. The hard-won learnings from the perfumes fetch, in one
 * place:
 *
 * - **Persistent on-disk profile** — keeps the clearance cookie across pages and
 *   across runs, so the gate sees a returning, trusted browser.
 * - **Real-Chrome channel** (with a bundled-chromium fallback) — a genuine Chrome
 *   build looks like an ordinary desktop browser rather than automation.
 * - **Anti-automation flag + realistic UA/viewport/locale** — removes the obvious
 *   `navigator.webdriver` tell.
 * - **Stale-lock cleanup** — a crashed run can strand `Singleton*` locks that
 *   block the next launch; we remove them first.
 *
 * The block these settings defeat is rate/reputation-based, NOT per-request
 * detection — so callers should ALSO pace their requests (a jittered min-interval,
 * ideally via a shared service) to stay reputable. This helper owns the *launch*;
 * pacing stays with the caller (see `jitterMs`).
 *
 * @param launch injectable launcher; defaults to `chromium.launchPersistentContext`.
 */
export async function launchPersistentBrowser(
  opts: PersistentBrowserOptions,
  launch: PersistentLauncher = defaultLauncher,
): Promise<BrowserContext> {
  const base: Record<string, unknown> = {
    headless: opts.headless ?? true,
    viewport: opts.viewport ?? { width: 1280, height: 1800 },
    userAgent: opts.userAgent ?? DESKTOP_CHROME_UA,
    locale: opts.locale ?? 'en-GB',
    args: ['--disable-blink-features=AutomationControlled', ...(opts.args ?? [])],
  };
  // Clear any stale single-instance locks left by a crashed run.
  for (const f of PROFILE_LOCK_FILES) {
    try { rmSync(join(opts.profileDir, f), { force: true }); } catch { /* ignore */ }
  }
  const channel = opts.channel;
  try {
    return await launch(opts.profileDir, channel ? { ...base, channel } : base);
  } catch (e) {
    if (!channel) throw e;
    opts.log?.(
      `real Chrome (channel=${channel}) unavailable (${e instanceof Error ? e.message.split('\n')[0] : e}); using bundled chromium`,
      'warn',
    );
    return await launch(opts.profileDir, base);
  }
}

/**
 * A single jittered delay in `[baseMs, baseMs + maxJitterMs]`. The whole point of
 * a reputation gate is that *steady, human-paced, slightly-random* traffic stays
 * trusted; perfectly periodic requests read as a bot. Callers that don't route
 * through a shared rate-limited service can use this to pace their own loop.
 *
 * @param rng injectable [0,1) source; defaults to `Math.random` (tests pass a stub).
 */
export function jitteredDelayMs(baseMs: number, maxJitterMs: number, rng: () => number = Math.random): number {
  return Math.round(baseMs + rng() * Math.max(0, maxJitterMs));
}
