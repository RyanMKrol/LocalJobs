'use client';

import type { CSSProperties } from 'react';

/**
 * Shared pill/chip component. Wraps the `.pill` CSS class idiom from globals.css
 * so callers don't scatter bare `<span className="pill ...">` everywhere.
 *
 * `kind` maps to the modifier class appended to `.pill` (e.g. kind="on" →
 * className="pill on"). Omit `kind` for a plain unstyled pill.
 *
 * Common kinds (matching existing CSS in globals.css):
 *   on / off          – workflow enabled toggle
 *   paid / free       – service billing type
 *   certified         – certified workflow badge
 */

interface PillProps {
  kind?: string;
  title?: string;
  style?: CSSProperties;
  children: React.ReactNode;
}

export function Pill({ kind, title, style, children }: PillProps) {
  const cls = kind ? `pill ${kind}` : 'pill';
  return (
    <span className={cls} title={title} style={style}>
      {children}
    </span>
  );
}
