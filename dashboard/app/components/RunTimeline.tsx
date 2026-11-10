'use client';

import Link from 'next/link';
import type { Run } from '../lib/api';
import { fmtDuration } from '../ui';

/**
 * When each stage of a workflow run was waiting and when it was working, drawn
 * on one shared time axis: one row per stage, one bar per attempt.
 *
 * A bar has two parts. The pale part runs from the moment the stage became
 * ready (everything it depends on had finished) to the moment its process
 * started: time spent waiting for a free slot and on the checks of its inputs.
 * The solid part is the attempt itself, coloured by how it ended. Stages that
 * ran side by side line up one above the other, so what ran in parallel, what
 * held everything up and what was retried can be read at a glance.
 *
 * It draws only from the millisecond timestamps the engine records on each
 * member run, so a run from before those existed shows no timeline at all.
 */
export function RunTimeline({ members, stageOrder }: { members: Run[]; stageOrder: string[] }) {
  const timed = members.filter((r) => r.started_at_ms != null);
  if (timed.length < 2) return null;

  const now = Date.now();
  const startOf = (r: Run) => Math.min(r.queued_at_ms ?? r.started_at_ms!, r.started_at_ms!);
  const endOf = (r: Run) => r.finished_at_ms ?? (r.status === 'running' ? now : r.started_at_ms!);
  const t0 = Math.min(...timed.map(startOf));
  const t1 = Math.max(...timed.map(endOf));
  const span = Math.max(t1 - t0, 1);
  const pct = (ms: number) => `${Math.min(100, Math.max(0, ((ms - t0) / span) * 100))}%`;
  const width = (from: number, to: number) => `${Math.max(0, ((to - from) / span) * 100)}%`;

  const byStage = new Map<string, Run[]>();
  for (const r of timed) (byStage.get(r.job_name) ?? byStage.set(r.job_name, []).get(r.job_name)!).push(r);
  // Stages in the order of the workflow's own graph; any the graph does not name go last.
  const stages = [...stageOrder.filter((s) => byStage.has(s)), ...[...byStage.keys()].filter((s) => !stageOrder.includes(s))];

  return (
    <>
      <h2>Timeline</h2>
      <div className="panel run-timeline">
        <div className="run-timeline-axis">
          <span>0s</span>
          <span>{fmtDuration(Math.round(span / 2))}</span>
          <span>{fmtDuration(span)}</span>
        </div>
        {stages.map((stage) => {
          const attempts = byStage.get(stage)!;
          const worked = attempts.reduce((sum, r) => sum + (endOf(r) - r.started_at_ms!), 0);
          return (
            <div className="run-timeline-row" key={stage}>
              <div className="run-timeline-label" title={stage}>{stage}</div>
              <div className="run-timeline-track">
                {attempts.map((r) => {
                  const queued = startOf(r);
                  const started = r.started_at_ms!;
                  const ended = endOf(r);
                  const waited = started - queued;
                  const what = [
                    `${stage}, attempt ${r.attempt}${r.cycle && r.cycle > 1 ? `, cycle ${r.cycle}` : ''}: ${r.status}`,
                    `ran ${fmtDuration(ended - started)}`,
                    waited >= 1000 ? `waited ${fmtDuration(waited)} first${r.gate_ms ? ` (${fmtDuration(r.gate_ms)} of it checking inputs)` : ''}` : null,
                  ].filter(Boolean).join(' · ');
                  return (
                    <span key={r.id}>
                      {waited > 0 && <span className="run-timeline-wait" style={{ left: pct(queued), width: width(queued, started) }} title={what} />}
                      <Link
                        href={`/runs/${r.id}`}
                        className={`run-timeline-bar ${r.status}`}
                        style={{ left: pct(started), width: width(started, ended) }}
                        title={what}
                        aria-label={what}
                      />
                    </span>
                  );
                })}
              </div>
              <div className="run-timeline-total mono">{fmtDuration(worked)}{attempts.length > 1 ? ` · ${attempts.length} attempts` : ''}</div>
            </div>
          );
        })}
        <p className="run-timeline-key muted">
          <span className="run-timeline-swatch wait" /> waiting to start
          <span className="run-timeline-swatch success" /> ran
          <span className="run-timeline-swatch failed" /> failed
          <span className="run-timeline-swatch running" /> running
        </p>
      </div>
    </>
  );
}
