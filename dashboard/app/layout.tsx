import './globals.css';
import type { ReactNode } from 'react';

export const metadata = {
  title: 'Local Jobs',
  description: 'Local job orchestrator dashboard',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site">
          <div className="inner">
            <span className="brand">⚙︎ Local Jobs</span>
            <nav>
              <a href="/">Overview</a>
              <a href="/jobs">Jobs</a>
            </nav>
          </div>
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
