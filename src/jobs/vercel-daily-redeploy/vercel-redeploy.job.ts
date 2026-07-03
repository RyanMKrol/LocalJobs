import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';

import type { JobContext, JobDefinition } from '../../core/types.js';

/** Injectable child-process spawn (real implementation runs the Vercel CLI; tests stub this). */
export type SpawnFn = (cwd: string) => ChildProcess;

const DEFAULT_TIMEOUT_MS = 600_000; // 10 min — a real build+deploy, not an HTTP call

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
  opts: { checkoutPath?: string; spawnFn?: SpawnFn; timeoutMs?: number } = {},
): Promise<void> {
  const checkoutPath = opts.checkoutPath ?? process.env.RYANKROL_CO_UK_PATH;
  if (!checkoutPath) {
    ctx.log('RYANKROL_CO_UK_PATH not configured — skipping redeploy (see .env.example)', 'warn');
    return;
  }
  if (!existsSync(checkoutPath)) {
    ctx.log(`RYANKROL_CO_UK_PATH (${checkoutPath}) does not exist on disk — skipping redeploy`, 'warn');
    return;
  }

  const spawnFn = opts.spawnFn ?? defaultSpawn;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  ctx.log(
    `Running "vercel --prod --yes" in ${checkoutPath} — a direct production deploy of the current ` +
      'working tree, independent of Git integration/auto-deploy state...',
  );

  await new Promise<void>((resolvePromise, reject) => {
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
      for (const line of text.split('\n')) {
        if (line.trim()) ctx.log(`vercel (stderr): ${line.trim()}`, 'warn');
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
      resolvePromise();
    });
  });
}

const job: JobDefinition = {
  name: 'vercel-redeploy',
  description:
    'Run "vercel --prod --yes" directly in the ryankrol.co.uk checkout — a daily safety-net ' +
    'production deploy in case that repo\'s own deploy task fails or a session forgets to author one.',
  timeoutMs: 660_000,
  maxRetries: 1,
  async run(ctx) {
    await runVercelRedeploy(ctx);
  },
};

export default job;
