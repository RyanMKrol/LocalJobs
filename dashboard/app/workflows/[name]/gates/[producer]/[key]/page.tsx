'use client';

import { use } from 'react';
import { api } from '../../../../../lib/api';
import type { ArtifactShape } from '../../../../../lib/api';
import { usePoll } from '../../../../../ui';

/**
 * The body of a definition-level contract panel: ONLY the declared expected shape
 * (summary · format · expectations) — never per-run actuals (no run in scope).
 * Shared by the two-sided `SideCard` and the collapsed single-panel view.
 */
function ShapeBody({ shape }: { shape: ArtifactShape | null }) {
  return (
    <>
      {shape?.summary && <p className="gate-summary">{shape.summary}</p>}
      {shape?.format && <code className="code-block gate-format">{shape.format}</code>}
      {shape?.expectations?.length ? (
        <ul className="gate-expects">
          {shape.expectations.map((e) => (
            <li key={e.label}>
              <span className="gate-mark pending" title="expected (no run in scope)">•</span>
              <span className="gate-expect-text">
                <span className="gate-expect-label">{e.label}</span>
                {e.detail && <span className="muted gate-expect-detail">{e.detail}</span>}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No declared shape for this side.</p>
      )}
    </>
  );
}

/**
 * One side of the gate flow — the upstream 'Produced →' or downstream '→ Consumed'.
 * This is the DEFINITION-level view: it shows ONLY the contract's declared expected
 * shape (summary · format · expectations), never any per-run actuals — there is no
 * run in scope here. Links through to the member job's own read-only page.
 */
function SideCard({
  role,
  jobName,
  shape,
}: {
  role: 'Produced →' | '→ Consumed';
  jobName: string;
  shape: ArtifactShape | null;
}) {
  return (
    <div className="gate-card">
      <div className="gate-card-head">
        <span className="gate-role">{role}</span>
        <strong>{jobName}</strong>
      </div>
      <ShapeBody shape={shape} />
      <p className="gate-card-foot"><a href={`/jobs/${jobName}`}>view {jobName} →</a></p>
    </div>
  );
}

/**
 * Run-AGNOSTIC, definition-level detail for ONE validation gate (T102). Reached
 * from the workflow DEFINITION view (`/workflows/[name]`) — it explains the gate
 * itself (the contract: artifact key, description, producer→consumer, and each
 * side's declared expected shape) independent of any one run. The run-scoped page
 * (`/workflow-runs/[id]/gates/...`) is the one that shows a specific run's
 * actual-vs-expected; this one never touches a run.
 */
export default function StructuralGateDetail({
  params,
}: {
  params: Promise<{ name: string; producer: string; key: string }>;
}) {
  const { name, producer, key } = use(params);
  const decodedProducer = decodeURIComponent(producer);
  const decodedKey = decodeURIComponent(key);

  const { data } = usePoll(
    () => api.workflowGate(name, decodedProducer, decodedKey),
    5000,
    [name, decodedProducer, decodedKey],
  );
  const gate = data?.gate;

  return (
    <>
      <p className="muted"><a href={`/workflows/${name}`}>← {name}</a></p>
      <div className="row">
        <h1 style={{ margin: 0 }}>Validation gate</h1>
        <div className="spacer" />
        {gate && <span className="badge">definition</span>}
      </div>

      {!gate && <p className="muted">Gate not found.</p>}

      {gate && (
        <>
          <p className="sub">
            Checks the <span className="mono">{gate.key}</span> artifact handed from{' '}
            <strong>{gate.producer}</strong> to <strong>{gate.consumer}</strong>.
          </p>

          {(() => {
            const gateCenter = (
              <div className="gate-card gate-center">
                <div className="gate-card-head">
                  <span className="gate-role">Gate</span>
                </div>
                <code className="code-block gate-format">{gate.key}</code>
                <p className="muted">
                  {gate.description ?? 'Validates the artifact above is well-formed before the next stage runs.'}
                </p>
              </div>
            );

            // Collapsed view (T138): when both sides declare the SAME shape (the
            // normal case — one contract factory wired as both produces[key] and
            // consumes[key]), the two side panels are redundant, so show ONE
            // consolidated contract panel. The boundary above already states
            // producer→consumer; member-page links live in the footer.
            if (data?.identical) {
              const shape = data.produced?.shape ?? data.consumed?.shape ?? null;
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
                    <ShapeBody shape={shape} />
                    <p className="gate-card-foot">
                      <a href={`/jobs/${gate.producer}`}>view {gate.producer} →</a>
                      <span className="muted"> · </span>
                      <a href={`/jobs/${gate.consumer}`}>view {gate.consumer} →</a>
                    </p>
                  </div>
                </div>
              );
            }

            // Asymmetric gate: keep the full two-sided 'Produced → | Gate | → Consumed' view.
            return (
              <div className="gate-flow">
                <SideCard role="Produced →" jobName={gate.producer} shape={data?.produced?.shape ?? null} />

                <div className="gate-arrow" aria-hidden>→</div>

                {gateCenter}

                <div className="gate-arrow" aria-hidden>→</div>

                <SideCard role="→ Consumed" jobName={gate.consumer} shape={data?.consumed?.shape ?? null} />
              </div>
            );
          })()}

          <p className="muted" style={{ marginTop: 16 }}>
            This is the gate&apos;s definition — what it checks, independent of any run. To see a
            specific run&apos;s pass/fail against the actual artifact, open that run and click the gate
            on its graph.
          </p>
        </>
      )}
    </>
  );
}
