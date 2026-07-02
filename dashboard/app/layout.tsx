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
            <nav>
              <a href="/">Overview</a>
              <a href="/workflows">Workflows</a>
              <a href="/services">Integrations</a>
              <a href="/backlog">Backlog</a>
              <a href="/logs">Logs</a>
            </nav>
            <ThemeControls />
          </div>
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
