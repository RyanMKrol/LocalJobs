import './globals.css';
import type { ReactNode } from 'react';
import { Baloo_2, Space_Mono } from 'next/font/google';
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

// ── Curated font set (T184) ─────────────────────────────────────────────────
// The owner picked the two keepers from the T142/T154 experiment: Baloo 2 (a
// rounded body face) and Space Mono. The third option is the unset System
// default. Each is loaded once via next/font/google (self-hosted, `display:
// swap` so there's no blocking FOUC) and exposes a CSS custom property attached
// to <html>; the font *switcher* remaps `--font-display`/`--font-body`/
// `--font-mono` to one of them via `html[data-font="…"]` in globals.css.
const baloo = Baloo_2({ subsets: ['latin'], variable: '--font-baloo', display: 'swap' });
const spaceMono = Space_Mono({ subsets: ['latin'], weight: ['400', '700'], variable: '--font-spacemono', display: 'swap' });

const fontVars = [baloo, spaceMono].map((f) => f.variable).join(' ');

// Inline pre-paint script: applies the persisted theme-family / font / motion / mode
// choices to <html> BEFORE first paint so there's no flash. Mirrors
// useTheme/useFont/useMotion/useMode in ui.tsx.
// Mode (localjobs.mode): 'dark'→force dark, 'light'→force light, 'system'/absent→
// follow OS prefers-color-scheme. The `default` family's DARK mode is the original
// pre-T142 dark look (the :root palette); its light mode is the new counterpart.
// Nothing stored keeps the system font; motion honours the OS `prefers-reduced-motion`
// until overridden.
const PREPAINT = `(function(){try{
var d=document.documentElement,L=window.localStorage;
var mo=L.getItem('localjobs.mode');
var dark=mo==='dark'||(mo!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);
d.setAttribute('data-mode',dark?'dark':'light');
var t=L.getItem('localjobs.theme'); if(t&&t!=='default') d.setAttribute('data-theme',t);
var f=L.getItem('localjobs.font'); if(f&&f!=='system') d.setAttribute('data-font',f);
var m=L.getItem('localjobs.motion');
var reduced=m==='reduced'||(m==null&&window.matchMedia('(prefers-reduced-motion: reduce)').matches);
if(reduced) d.setAttribute('data-motion','reduced');
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
              <a href="/services">Services</a>
              <a href="/db">Database</a>
              <a href="/backlog">Backlog</a>
            </nav>
            <ThemeControls />
          </div>
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
