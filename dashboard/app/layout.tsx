import './globals.css';
import type { ReactNode } from 'react';
import { Baloo_2 } from 'next/font/google';
import { ThemeControls } from './ui';

export const metadata = {
  title: 'Local Jobs',
  description: 'Local job orchestrator dashboard',
};

// Make the layout scale to the device width so the mobile media queries apply on
// phones (instead of rendering at a desktop width and being zoomed out).
export const viewport = {
  width: 'device-width',
  initialScale: 1,
};

// ── Hardcoded font (T308) ────────────────────────────────────────────────────
// The dashboard's appearance is hardcoded to the sunny-8bit theme + Baloo 2 —
// no theme/font switcher. Loaded once via next/font/google (self-hosted,
// `display: swap` so there's no blocking FOUC) and exposed as a CSS custom
// property attached to <html>; globals.css's base `:root` maps
// `--font-display`/`--font-body` to it.
const baloo = Baloo_2({ subsets: ['latin'], variable: '--font-baloo', display: 'swap' });

const fontVars = baloo.variable;

// Inline pre-paint script: applies the persisted light/dark mode choice to <html>
// BEFORE first paint so there's no flash. Mirrors useMode in ui.tsx.
// 'dark'→force dark, 'light'→force light, absent→follow OS prefers-color-scheme.
const PREPAINT = `(function(){try{
var d=document.documentElement,L=window.localStorage;
var mo=L.getItem('localjobs.mode');
var dark=mo==='dark'||(mo!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);
d.setAttribute('data-mode',dark?'dark':'light');
}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={fontVars} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: PREPAINT }} />
      </head>
      <body>
        <header className="site">
          <div className="inner">
            <a href="/" className="brand">⚙︎ Local Jobs</a>
            {/*
              The nav gained a 6th tab (Admin, T323), which no longer fits on one line at
              mobile widths. Making nav its own (always-on) flex-wrap container lets its
              links wrap onto extra rows within the nav's own box at narrow viewports,
              instead of pushing the page wider. But nav's `width: '100%'` makes it compete
              with its `.brand` flex sibling for space at EVERY width, not just mobile — left
              unchecked that starves `.brand` and wraps the "⚙︎ Local Jobs" text onto two
              lines (the T400 regression). `.brand` now has `flex-shrink: 0` +
              `white-space: nowrap` in globals.css specifically so it always keeps its
              natural width and wins that competition, leaving nav only the remaining space
              to wrap within.
            */}
            <nav style={{ width: '100%', boxSizing: 'border-box', display: 'flex', flexWrap: 'wrap', rowGap: 6 }}>
              <a href="/">Overview</a>
              <a href="/workflows">Workflows</a>
              <a href="/integrations">Integrations</a>
              <a href="/backlog">Backlog</a>
              <a href="/logs">Logs</a>
              <a href="/admin">Admin</a>
            </nav>
            <ThemeControls />
          </div>
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
