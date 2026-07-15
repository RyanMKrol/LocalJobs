'use client';

import { use } from 'react';
import Link from 'next/link';
import { api } from '../../../../../lib/api';
import type { ArtifactShape, ExpectationResult, GateResult } from '../../../../../lib/api';
import { StatusBadge, WorkflowRunBackLink, usePoll } from '../../../../../ui';

/** Pair each declared expectation with its actual result (matched by label). */
function pairExpectations(shape: ArtifactShape | null, result: GateResult | null) {
  const byLabel = new Map<string, ExpectationResult>();
  for (const c of result?.checks ?? []) byLabel.set(c.label, c);
  // Show every declared expectation, plus any check result with no declared
  // expectation (defensive — keeps an unmatched actual visible).
  const declared = shape?.expectations ?? [];
  const extra = (result?.checks ?? []).filter((c) => !declared.some((e) => e.label === c.label));
  return [
    ...declared.map((e) => ({ label: e.label, detail: e.detail, actual: byLabel.get(e.label) })),
    ...extra.map((c) => ({ label: c.label, detail: undefined as string | undefined, actual: c })),
  ];
}

/** A check mark / cross / dash for one expectation's pass/fail/unknown state. */
function Mark({ actual }: { actual?: ExpectationResult }) {
  if (!actual) return <span className="gate-mark pending" title="not evaluated yet">—</span>;
  return actual.ok
    ? <span className="gate-mark pass" title="satisfied">✓</span>
    : <span className="gate-mark fail" title="not satisfied">✗</span>;
}

/**
 * The body of one contract panel: the declared shape (summary · format ·
 * per-expectation list) plus, when the stage has run, the per-expectation
 * pass/fail against what actually flowed and a small sample. Shared by the
 * two-sided `SideCard` and the collapsed single-panel view so they stay in sync.
 */
function ShapeBody({
  shape,
  result,
}: {
  shape: ArtifactShape | null;
  result: GateResult | null;
}) {
  const rows = pairExpectations(shape, result);
  return (
    <>
      {shape?.summary && <p className="gate-summary">{shape.summary}</p>}
      {shape?.format && <code className="code-block gate-format">{shape.format}</code>}
      {rows.length > 0 ? (
        <ul className="gate-expects">
          {rows.map((r) => (
            <li key={r.label}>
              <Mark actual={r.actual} />
              <span className="gate-expect-text">
                <span className="gate-expect-label">{r.label}</span>
                {r.detail && <span className="muted gate-expect-detail">{r.detail}</span>}
                {r.actual?.actual && (
                  <span className="gate-expect-actual-wrap">
                    <span className="gate-expect-actual-label">actual</span>
                    <code className="code-block gate-expect-actual">{r.actual.actual}</code>
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No declared shape for this side.</p>
      )}
      {result?.sample && (
        <div className="gate-sample">
          <p className="gate-sample-label muted">What actually flowed:</p>
          <code className="code-block">{result.sample}</code>
        </div>
      )}
      {!result && <p className="muted">This stage hasn&apos;t run yet — showing the expected shape only.</p>}
    </>
  );
}

/**
 * One side of the gate flow — the upstream 'Produced →' or downstream '→ Consumed'.
 * Shows the stage name, the artifact's declared shape (what's expected) and, when the
 * stage has run, the per-expectation pass/fail against what actually flowed plus
 * a small sample.
 */
function SideCard({
  role,
  logLabel,
  jobName,
  side,
  runId,
}: {
  role: 'Produced →' | '→ Consumed';
  logLabel: string;
  jobName: string;
  side: { shape: ArtifactShape | null; result: GateResult | null } | null;
  runId?: string;
}) {
  return (
    <div className="gate-card">
      <div className="gate-card-head">
        <span className="gate-role">{role}</span>
        <strong>{jobName}</strong>
      </div>
      <ShapeBody shape={side?.shape ?? null} result={side?.result ?? null} />
      {runId && <p className="gate-card-foot"><Link href={`/runs/${runId}`}>view {logLabel} logs →</Link></p>}
    </div>
  );
}

export default function GateDetail({
  params,
}: {
  params: Promise<{ id: string; producer: string; key: string }>;
}) {
  const { id, producer, key } = use(params);
  const decodedProducer = decodeURIComponent(producer);
  const decodedKey = decodeURIComponent(key);

  const { data, error } = usePoll(() => api.workflowRun(id), 2000, [id]);
  const { data: inspect } = usePoll(
    () => api.gateInspection(id, decodedProducer, decodedKey),
    2000,
    [id, decodedProducer, decodedKey],
  );
  const run = data?.run;
  const members = data?.jobs ?? [];

  const gate = inspect?.gate;

  const runIdByJob: Record<string, string> = {};
  for (const r of members) runIdByJob[r.job_name] = r.id;

  const producerRunId = gate ? runIdByJob[gate.producer] : undefined;
  const consumerRunId = gate
    ? gate.state === 'failed'
      ? (gate.failureRunId ?? undefined)
      : runIdByJob[gate.consumer]
    : undefined;

  return (
    <>
      <WorkflowRunBackLink
        workflowRunId={run ? id : null}
        workflowName={run?.workflow_name}
        fallback={{ href: '/workflows', label: 'workflows' }}
      />
      {error && <p className="muted">⚠ Cannot reach the daemon API ({error}).</p>}
      <div className="row">
        <h1 style={{ margin: 0 }}>Validation gate</h1>
        <div className="spacer" />
        {gate && <StatusBadge status={gate.state} />}
      </div>

      {!gate && <p className="muted">Gate not found.</p>}

      {gate && (
        <>
          <p className="sub">
            Checks the <span className="mono">{gate.key}</span> artifact handed from{' '}
            <strong>{gate.producer}</strong> to <strong>{gate.consumer}</strong>.
          </p>

          {/* Gate center block — key + description + state + violation link. Shared
              by both the two-sided and the collapsed (identical-contract) layouts. */}
          {(() => {
            const gateCenter = (
              <div className="gate-card gate-center">
                <div className="gate-card-head">
                  <span className="gate-role">Gate</span>
                  <StatusBadge status={gate.state} />
                </div>
                <code className="code-block gate-format">{gate.key}</code>
                <p className="muted">
                  {gate.description ?? 'Validates the artifact above is well-formed before the next stage runs.'}
                </p>
                {gate.state === 'failed' && consumerRunId && (
                  <p className="gate-card-foot"><Link href={`/runs/${consumerRunId}`}>view violation logs →</Link></p>
                )}
              </div>
            );

            // Collapsed view (T138): when the producer's `produces[key]` and the
            // consumer's `consumes[key]` declare the SAME shape (the normal case —
            // one factory wired on both sides), the two side panels are redundant,
            // so show ONE consolidated contract panel. The boundary above already
            // states producer→consumer; the per-side log links live in the footer.
            if (inspect?.identical) {
              const side = inspect.produced ?? inspect.consumed ?? null;
              return (
                <div className="gate-flow">
                  {gateCenter}
                  <div className="gate-arrow" aria-hidden>→</div>
                  <div className="gate-card">
                    <div className="gate-card-head">
                      <span className="gate-role">Contract</span>
                      <strong className="mono">{gate.key}</strong>
                    </div>
                    <p className="muted gate-collapsed-note">
                      {gate.producer} and {gate.consumer} agree on one shape.
                    </p>
                    <ShapeBody shape={side?.shape ?? null} result={side?.result ?? null} />
                    <p className="gate-card-foot">
                      {producerRunId && <Link href={`/runs/${producerRunId}`}>producer logs →</Link>}
                      {producerRunId && consumerRunId && gate.state !== 'failed' && <span className="muted"> · </span>}
                      {consumerRunId && gate.state !== 'failed' && <Link href={`/runs/${consumerRunId}`}>consumer logs →</Link>}
                    </p>
                  </div>
                </div>
              );
            }

            // Asymmetric gate: keep the full two-sided 'Produced → | Gate | → Consumed' diff.
            return (
              <div className="gate-flow">
                <SideCard role="Produced →" logLabel="producer" jobName={gate.producer} side={inspect?.produced ?? null} runId={producerRunId} />

                <div className="gate-arrow" aria-hidden>→</div>

                {gateCenter}

                <div className="gate-arrow" aria-hidden>→</div>

                <SideCard role="→ Consumed" logLabel="consumer" jobName={gate.consumer} side={inspect?.consumed ?? null} runId={gate.state === 'failed' ? undefined : consumerRunId} />
              </div>
            );
          })()}
        </>
      )}
    </>
  );
}
