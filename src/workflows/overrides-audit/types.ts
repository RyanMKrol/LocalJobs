// Shared types for the overrides-audit report-only workflow.
import type { StaleOverride } from '../../db/store.js';

export interface StaleOverrideReportRow {
  table: StaleOverride['table'];
  name: string;
  field: string;
  currentValue: unknown;
  overriddenAt: string | null;
  /** Human-readable age, or "unknown (since before this feature existed)" when NULL-timestamped. */
  ageHuman: string;
}

/** The workflow's output artifact — every override that's stale enough to consider folding into code. */
export interface StaleOverridesReport {
  generatedAt: string;
  minAgeDays: number;
  count: number;
  items: StaleOverrideReportRow[];
}
