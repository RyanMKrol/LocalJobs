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
  /** Optional header action (e.g. a flat "Un-ignore all" button for non-grouped managers). */
  action?: ReactNode;
}

export function IgnoredSection({ count, subtitle, children, action }: IgnoredSectionProps) {
  return (
    <div className="panel ignored-section">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <h3 className="ignored-section-heading">Ignored ({count})</h3>
        {action}
      </div>
      <p className="muted ignored-section-subtitle">{subtitle}</p>
      {children}
    </div>
  );
}
