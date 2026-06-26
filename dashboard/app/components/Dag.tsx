'use client';

/**
 * DAG wrapper — selects between prototype graph options (T220).
 *
 * Reads the user's chosen graph style from localStorage (via `useDagOption`)
 * and renders the matching implementation:
 *  - 'waves'    → DagWaves   (wave-column layout with bezier edges)
 *  - 'swimlane' → DagSwimlane (horizontal swim-lane layout per wave)
 *  - 'flow'     → DagFlow    (React Flow + dagre layout, interactive)
 *
 * All three implementations accept the same props as the original Dag component,
 * so callers (workflow detail page, run detail page) are unchanged.
 */

import type { GateStatus, StructuralGate, WorkflowMember } from '../lib/api';
import { DagOptionSwitcher, useDagOption } from '../ui';
import { DagFlow } from './DagFlow';
import { DagSwimlane } from './DagSwimlane';
import { DagWaves } from './DagWaves';

export interface DagProps {
  members: WorkflowMember[];
  statusByJob?: Record<string, string>;
  runIdByJob?: Record<string, string>;
  /** Validation-gate states for THIS run; omit on the structure-only view. */
  gates?: GateStatus[];
  /** Structural gates for the definition view (no run state). */
  structuralGates?: StructuralGate[];
  /** Workflow name; when provided, structural gate chips link to that workflow's
   *  run-AGNOSTIC, definition-level gate detail page. */
  workflowName?: string;
  /** Path of the page rendering this DAG, threaded onto node links as `?from=`. */
  from?: string;
  /** Workflow run id, required when `gates` is provided to build gate-detail URLs. */
  workflowRunId?: string;
}

export function Dag(props: DagProps) {
  const [option] = useDagOption();
  return (
    <div>
      <DagOptionSwitcher />
      {option === 'flow' ? (
        <DagFlow {...props} />
      ) : option === 'swimlane' ? (
        <DagSwimlane {...props} />
      ) : (
        <DagWaves {...props} />
      )}
    </div>
  );
}
