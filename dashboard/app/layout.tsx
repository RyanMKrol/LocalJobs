import './globals.css';
import type { ReactNode } from 'react';

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

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
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
          </div>
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
