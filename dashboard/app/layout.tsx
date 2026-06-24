import './globals.css';
import type { ReactNode } from 'react';
import {
  Pixelify_Sans,
  Nunito,
  Quicksand,
  Fredoka,
  Baloo_2,
  Comfortaa,
  Varela_Round,
  Rubik,
  Mulish,
  Poppins,
  Lexend,
  Space_Mono,
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

// ── Joyful font set (T142; narrowed to ROUNDED + a Space Mono cluster in T154) ──
// Each font is loaded once via next/font/google (self-hosted, `display: swap` so
// there's no blocking FOUC) and exposes a CSS custom property. ALL the variables
// are attached to <html>, so they're always defined; the font *switcher* just
// remaps `--font-display`/`--font-body`/`--font-mono` to a chosen face via
// `html[data-font="…"]` in globals.css. The owner's round-1 verdict narrowed the
// body face to the ROUNDED family (Fredoka/Nunito + 8 more) plus a small Space
// Mono cluster; the only pixel face kept is Pixelify_Sans, used as a DISPLAY
// (heading) face only — never on body/table/log text.
const pixelify = Pixelify_Sans({ subsets: ['latin'], variable: '--font-pixelify', display: 'swap' });
const nunito = Nunito({ subsets: ['latin'], variable: '--font-nunito', display: 'swap' });
const quicksand = Quicksand({ subsets: ['latin'], variable: '--font-quicksand', display: 'swap' });
const fredoka = Fredoka({ subsets: ['latin'], variable: '--font-fredoka', display: 'swap' });
const baloo = Baloo_2({ subsets: ['latin'], variable: '--font-baloo', display: 'swap' });
const comfortaa = Comfortaa({ subsets: ['latin'], variable: '--font-comfortaa', display: 'swap' });
const varela = Varela_Round({ subsets: ['latin'], weight: ['400'], variable: '--font-varela', display: 'swap' });
const rubik = Rubik({ subsets: ['latin'], variable: '--font-rubik', display: 'swap' });
const mulish = Mulish({ subsets: ['latin'], variable: '--font-mulish', display: 'swap' });
const poppins = Poppins({ subsets: ['latin'], weight: ['300', '400', '500', '600', '700'], variable: '--font-poppins', display: 'swap' });
const lexend = Lexend({ subsets: ['latin'], variable: '--font-lexend', display: 'swap' });
const spaceMono = Space_Mono({ subsets: ['latin'], weight: ['400', '700'], variable: '--font-spacemono', display: 'swap' });

const fontVars = [
  pixelify, nunito, quicksand, fredoka, baloo,
  comfortaa, varela, rubik, mulish, poppins, lexend, spaceMono,
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
