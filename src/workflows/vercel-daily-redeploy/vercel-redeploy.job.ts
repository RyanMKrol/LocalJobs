import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveWorkflowDataDir } from '../../config.js';
import { dayKey } from '../../core/dates.js';
import { callService, QuotaExceededError } from '../../core/services.js';
import { defineStage, fromChecks, inlineArtifact, type JobContext } from '../../engine/index.js';
import { markWorkItem } from '../../db/store.js';

/** Injectable child-process spawn (real implementation runs the Vercel CLI; tests stub this). */
export type SpawnFn = (cwd: string) => ChildProcess;

const JOB_NAME = 'vercel-redeploy';
const DEFAULT_TIMEOUT_MS = 600_000; // 10 min — a real build+deploy, not an HTTP call

/** Which checkout a redeploy run targets — the same runner deploys every target. */
export interface RedeployTarget {
  jobName: string;
  envVarName: string;
  /** Prefix for the per-day JSON artifact under data/out/. */
  outPrefix: string;
}

const RYANKROL_TARGET: RedeployTarget = {
  jobName: JOB_NAME,
  envVarName: 'RYANKROL_CO_UK_PATH',
  outPrefix: 'vercel-redeploy',
};

export const POMODIARY_TARGET: RedeployTarget = {
  jobName: 'vercel-redeploy-pomodiary',
  envVarName: 'POMODIARY_PATH',
  outPrefix: 'vercel-redeploy-pomodiary',
};

// Resources live alongside the job itself, never in a far-off top-level folder.
const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(resolveWorkflowDataDir(resolve(here, 'data')), 'out');

type Outcome = 'deployed' | 'skipped' | 'failed';

/** What one redeploy attempt did: the stage's output. */
export interface RedeployResult {
  generatedAt: string;
  /** The day it was for (one deploy per day). */
  key: string;
  outcome: Outcome;
  deployUrl?: string;
  reason?: string;
}

const OUTCOMES: Outcome[] = ['deployed', 'skipped', 'failed'];

/** Both redeploy stages output this: small, so it is kept in the run record. */
export const redeployResult = inlineArtifact<RedeployResult>({
  key: 'vercel-redeploy-result',
  description: 'How the deploy went: deployed (with its URL), skipped (and why), or failed (and why).',
  check: (v) => fromChecks([{ label: 'a known outcome', ok: OUTCOMES.includes(v?.outcome), actual: String(v?.outcome) }]),
  summary: (v) => `${v.outcome}${v.deployUrl ? ` · ${v.deployUrl}` : ''}${v.reason ? ` · ${v.reason.slice(0, 120)}` : ''}`,
});

/**
 * Records this run's outcome twice. As the stage's OUTPUT (handed to `report`,
 * which commits it), so the run page says how the deploy went. And as ONE
 * per-day ledger row (T618), the deploy log: one deployment a day is the item
 * this stage produces, a same-day manual re-run overwrites the row rather than
 * duplicating it, and a failed deploy is a `failed` row that can be queried.
 * The row's `detail` points at a small JSON file under data/out/.
 */
function recordOutcome(
  target: RedeployTarget,
  key: string,
  outcome: Outcome,
  extra: { deployUrl?: string; reason?: string },
  status: 'success' | 'failed',
  report?: (result: RedeployResult) => void,
): void {
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, `${target.outPrefix}-${key}.json`);
  const body: RedeployResult = { generatedAt: new Date().toISOString(), key, outcome, ...extra };
  writeFileSync(outPath, JSON.stringify(body, null, 2));
  report?.(body);
  markWorkItem(target.jobName, key, status, {
    detail: {
      name: `Redeploy ${outcome} — ${key}`,
      outcome,
      ...extra,
      format: 'json',
      path: outPath,
    },
  });
}

export function defaultSpawn(cwd: string): ChildProcess {
  return spawn('vercel', ['--prod', '--yes'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Runs `vercel --prod --yes` directly in the `ryankrol.co.uk` checkout — a real CLI
 * deploy of the current working tree, not an HTTP call to a Deploy Hook. This works
 * regardless of whether that repo's Vercel Git integration is connected (as of
 * 2026-07-03 it deliberately is NOT — see that repo's own CLAUDE.md "Deploying"
 * section), since a CLI deploy needs no Git integration at all. Relies on the
 * Vercel CLI's own persistent login session (`vercel login`, already established on
 * this machine — the daemon runs as the same OS user) rather than a passed token, so
 * there is no new credential to provision.
 */
export async function runVercelRedeploy(
  ctx: JobContext,
  opts: {
    checkoutPath?: string;
    spawnFn?: SpawnFn;
    timeoutMs?: number;
    callServiceFn?: typeof callService;
    now?: Date;
    target?: RedeployTarget;
    /** Handed the outcome as soon as it is known, including just before a failed deploy throws. */
    report?: (result: RedeployResult) => void;
  } = {},
): Promise<void> {
  const now = opts.now ?? new Date();
  const key = dayKey(now);
  const target = opts.target ?? RYANKROL_TARGET;
  const checkoutPath = opts.checkoutPath ?? process.env[target.envVarName];
  if (!checkoutPath) {
    ctx.log(`${target.envVarName} not configured — skipping redeploy (see .env.example)`, 'warn');
    recordOutcome(target, key, 'skipped', { reason: `missing-config: ${target.envVarName} is not set` }, 'success', opts.report);
    return;
  }
  if (!existsSync(checkoutPath)) {
    ctx.log(`${target.envVarName} (${checkoutPath}) does not exist on disk — skipping redeploy`, 'warn');
    recordOutcome(
      target,
      key,
      'skipped',
      { reason: `missing-config: checkout path ${checkoutPath} does not exist on disk` },
      'success',
      opts.report,
    );
    return;
  }

  const spawnFn = opts.spawnFn ?? defaultSpawn;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const callServiceFn = opts.callServiceFn ?? callService;

  ctx.log(
    `Running "vercel --prod --yes" in ${checkoutPath} — a direct production deploy of the current ` +
      'working tree, independent of Git integration/auto-deploy state...',
  );

  let deployUrl: string | undefined;
  try {
    deployUrl = await callServiceFn('vercel', () => deployOnce(ctx, checkoutPath, spawnFn, timeoutMs)) as
      | string
      | undefined;
  } catch (e) {
    if (e instanceof QuotaExceededError) {
      ctx.log(`vercel service quota exhausted — skipping today's redeploy (${e.message})`, 'warn');
      recordOutcome(target, key, 'skipped', { reason: `quota-exhausted: ${e.message}` }, 'success', opts.report);
      return;
    }
    const reason = e instanceof Error ? e.message : String(e);
    recordOutcome(target, key, 'failed', { reason }, 'failed', opts.report);
    throw e;
  }

  recordOutcome(target, key, 'deployed', { deployUrl }, 'success', opts.report);
}

function deployOnce(ctx: JobContext, checkoutPath: string, spawnFn: SpawnFn, timeoutMs: number): Promise<string | undefined> {
  return new Promise<string | undefined>((resolvePromise, reject) => {
    let child: ChildProcess;
    try {
      child = spawnFn(checkoutPath);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }

    let out = '';
    let err = '';
    let killedForTimeout = false;
    const timer = setTimeout(() => {
      killedForTimeout = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer) => {
      const text = d.toString();
      out += text;
      for (const line of text.split('\n')) {
        if (line.trim()) ctx.log(`vercel: ${line.trim()}`);
      }
    });
    child.stderr?.on('data', (d: Buffer) => {
      const text = d.toString();
      err += text;
      // The Vercel CLI writes ALL of its normal human-readable build progress to
      // stderr by design (stdout is reserved for the final deploy URL) — logging
      // it as 'warn' would paint a fully successful deploy with dozens of
      // spurious warnings. Only the exit-code check below decides success/failure;
      // this is just routine progress, logged at 'info' like stdout.
      for (const line of text.split('\n')) {
        if (line.trim()) ctx.log(`vercel: ${line.trim()}`);
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killedForTimeout) {
        reject(new Error(`vercel --prod timed out after ${timeoutMs}ms and was killed`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`vercel --prod exited with code ${code}${err ? `: ${err.trim().slice(-500)}` : ''}`));
        return;
      }
      const deployUrl = out.trim().split('\n').filter(Boolean).pop();
      ctx.log(`Deploy succeeded${deployUrl ? ` — ${deployUrl}` : ''}.`);
      resolvePromise(deployUrl);
    });
  });
}

export default defineStage({
  name: 'vercel-redeploy',
  description:
    'Once a day this job runs "vercel --prod --yes" directly in the separate ryankrol.co.uk ' +
    'checkout, deploying that repo\'s current working tree to production as a safety net in case ' +
    'that repo\'s own deploy task fails or a session forgets to author one. It deploys via the ' +
    'real Vercel CLI rather than an HTTP call to a Deploy Hook because ryankrol.co.uk deliberately ' +
    'disconnected its Vercel Git integration, so a Deploy Hook is no longer a reliably viable ' +
    'trigger there; the CLI deploys the local working tree directly and needs no Git integration ' +
    'at all. It relies on the Vercel CLI\'s existing persistent login session already established ' +
    'on this machine, so there is no credential to provision for this job. The checkout path comes ' +
    'from the RYANKROL_CO_UK_PATH env var — if that var is unset or points at a path that does not ' +
    'exist on disk, the job logs a warning and soft-skips rather than failing. The spawned "vercel" ' +
    'process is subject to its own internal 10-minute timeout-and-kill, separate from and shorter ' +
    'than the job\'s own outer timeout, so a hung deploy is always cleaned up before the executor ' +
    'would otherwise need to hard-kill the job process itself.',
  timeoutMs: 660_000,
  maxRetries: 1,
  // Committed whatever happened, including just before a failed deploy fails the run.
  outputs: { result: { artifact: redeployResult } },
  async run(ctx) {
    await runVercelRedeploy(ctx, { report: (r) => ctx.output('result').write(r) });
  },
});
