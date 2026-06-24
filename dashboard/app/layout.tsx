import './globals.css';
import type { ReactNode } from 'react';
import {
  Pixelify_Sans,
  Silkscreen,
  VT323,
  Press_Start_2P,
  Nunito,
  Quicksand,
  Fredoka,
  Baloo_2,
  Space_Mono,
  JetBrains_Mono,
} from 'next/font/google';
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

// ── Joyful font set (T142, an evaluation aid) ────────────────────────────────
// Each font is loaded once via next/font/google (self-hosted, `display: swap` so
// there's no blocking FOUC) and exposes a CSS custom property. ALL the variables
// are attached to <html>, so they're always defined; the font *switcher* just
// remaps `--font-display`/`--font-body`/`--font-mono` to a chosen pair via
// `html[data-font="…"]` in globals.css. Pixel/retro display faces NEVER land on
// body/table/log text — those map only to readable body/mono faces.
const pixelify = Pixelify_Sans({ subsets: ['latin'], variable: '--font-pixelify', display: 'swap' });
const silkscreen = Silkscreen({ subsets: ['latin'], weight: ['400', '700'], variable: '--font-silkscreen', display: 'swap' });
const vt323 = VT323({ subsets: ['latin'], weight: ['400'], variable: '--font-vt323', display: 'swap' });
const pressStart = Press_Start_2P({ subsets: ['latin'], weight: ['400'], variable: '--font-pressstart', display: 'swap' });
const nunito = Nunito({ subsets: ['latin'], variable: '--font-nunito', display: 'swap' });
const quicksand = Quicksand({ subsets: ['latin'], variable: '--font-quicksand', display: 'swap' });
const fredoka = Fredoka({ subsets: ['latin'], variable: '--font-fredoka', display: 'swap' });
const baloo = Baloo_2({ subsets: ['latin'], variable: '--font-baloo', display: 'swap' });
const spaceMono = Space_Mono({ subsets: ['latin'], weight: ['400', '700'], variable: '--font-spacemono', display: 'swap' });
const jetbrains = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains', display: 'swap' });

const fontVars = [
  pixelify, silkscreen, vt323, pressStart, nunito,
  quicksand, fredoka, baloo, spaceMono, jetbrains,
].map((f) => f.variable).join(' ');

// Inline pre-paint script: applies the persisted theme / font / motion choices to
// <html> BEFORE first paint so there's no theme flash. Mirrors useTheme/useFont/
// useMotion in ui.tsx. Defaults (nothing stored) keep the current dark + system
// look, and motion honours the OS `prefers-reduced-motion` until overridden.
const PREPAINT = `(function(){try{
var d=document.documentElement,L=window.localStorage;
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
              <a href="/movie-gaps">Movie gaps</a>
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
