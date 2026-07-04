'use client';

/**
 * Shared "Ignored (N)" panel for workflow-detail managers (movie-recommendations,
 * tv-recommendations, missing-tv-seasons). Owns only the panel chrome — heading +
 * subtitle spacing — and takes each manager's own table as children, since the
 * table shape differs per manager.
 */

import type { ReactNode } from 'react';

interface IgnoredSectionProps {
  count: number;
  subtitle: string;
  children: ReactNode;
}

export function IgnoredSection({ count, subtitle, children }: IgnoredSectionProps) {
  return (
    <div className="panel ignored-section">
      <h3 className="ignored-section-heading">Ignored ({count})</h3>
      <p className="muted ignored-section-subtitle">{subtitle}</p>
      {children}
    </div>
  );
}
