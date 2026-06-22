'use client';

import { use } from 'react';
import { api } from '../../../../../lib/api';
import { statusLabel, usePoll } from '../../../../../ui';

export default function GateDetail({
  params,
}: {
  params: Promise<{ id: string; producer: string; key: string }>;
}) {
  const { id, producer, key } = use(params);
  const decodedProducer = decodeURIComponent(producer);
  const decodedKey = decodeURIComponent(key);

  const { data } = usePoll(() => api.workflowRun(id), 2000, [id]);
  const run = data?.run;
  const gates = data?.gates ?? [];
  const members = data?.jobs ?? [];

  const gate = gates.find((g) => g.producer === decodedProducer && g.key === decodedKey);

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
      <p className="muted">
        <a href={run ? `/workflow-runs/${id}` : '/workflows'}>
          ← {run ? `workflow run` : 'workflows'}
        </a>
      </p>
      <div className="row">
        <h1 style={{ margin: 0 }}>Validation gate</h1>
        <div className="spacer" />
        {gate && (
          <span className={`badge ${gate.state}`}>{statusLabel(gate.state)}</span>
        )}
      </div>

      {!gate && <p className="muted">Gate not found.</p>}

      {gate && (
        <>
          <div className="panel" style={{ marginBottom: 16 }}>
            <table>
              <tbody>
                <tr>
                  <th style={{ width: 140 }}>Artifact key</th>
                  <td><span className="mono">{gate.key}</span></td>
                </tr>
                <tr>
                  <th>Bridges</th>
                  <td>
                    <strong>{gate.producer}</strong>
                    {' → '}
                    <strong>{gate.consumer}</strong>
                  </td>
                </tr>
                <tr>
                  <th>State</th>
                  <td>
                    <span className={`badge ${gate.state}`}>{statusLabel(gate.state)}</span>
                  </td>
                </tr>
                <tr>
                  <th>Asserts</th>
                  <td className="muted">
                    {gate.description ?? (
                      <span className="mono">no contract description</span>
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <h2>Logs</h2>
          <div className="panel">
            <table>
              <tbody>
                {producerRunId ? (
                  <tr>
                    <td>Producer — {gate.producer}</td>
                    <td><a href={`/runs/${producerRunId}`}>view logs →</a></td>
                  </tr>
                ) : (
                  <tr>
                    <td colSpan={2} className="muted">Producer not run yet</td>
                  </tr>
                )}
                {consumerRunId ? (
                  <tr>
                    <td>
                      {gate.state === 'failed'
                        ? `Gate violation — ${gate.consumer}`
                        : `Consumer — ${gate.consumer}`}
                    </td>
                    <td>
                      <a href={`/runs/${consumerRunId}`}>
                        {gate.state === 'failed' ? 'view violation logs →' : 'view logs →'}
                      </a>
                    </td>
                  </tr>
                ) : (
                  <tr>
                    <td colSpan={2} className="muted">Consumer not run yet</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
