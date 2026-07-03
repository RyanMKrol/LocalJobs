// vercel-redeploy tests — hermetic: no real `vercel` CLI invocations, no filesystem
// dependency on a real checkout (a temp dir stands in). Uses an injected spawnFn.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';

import type { JobContext, LogLevel } from '../../core/types.js';
import { runVercelRedeploy, type SpawnFn } from './vercel-redeploy.job.js';

function fakeCtx(): JobContext & { logs: Array<{ message: string; level?: LogLevel }> } {
  const logs: Array<{ message: string; level?: LogLevel }> = [];
  return {
    logs,
    log(message: string, level?: LogLevel) { logs.push({ message, level }); },
    progress() {},
    selectedRoots: () => null,
    rootAllowed: () => true,
  };
}

/** A fake child process: stdout/stderr are EventEmitters, closes on the next tick with `exitCode`. */
function makeFakeChild(opts: { stdout?: string; stderr?: string; exitCode?: number; emitError?: Error } = {}): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  (child as unknown as { stdout: unknown }).stdout = stdout;
  (child as unknown as { stderr: unknown }).stderr = stderr;
  (child as unknown as { kill: (signal: string) => void }).kill = () => {};
  setImmediate(() => {
    if (opts.emitError) {
      child.emit('error', opts.emitError);
      return;
    }
    if (opts.stdout) stdout.emit('data', Buffer.from(opts.stdout));
    if (opts.stderr) stderr.emit('data', Buffer.from(opts.stderr));
    child.emit('close', opts.exitCode ?? 0);
  });
  return child;
}

describe('runVercelRedeploy', () => {
  it('soft-skips when RYANKROL_CO_UK_PATH is unset — spawnFn never called', async () => {
    const ctx = fakeCtx();
    let spawnCalled = false;
    const spawnFn: SpawnFn = () => { spawnCalled = true; return makeFakeChild(); };

    await runVercelRedeploy(ctx, { checkoutPath: undefined, spawnFn });

    assert.equal(spawnCalled, false);
    assert.ok(ctx.logs.some((l) => l.level === 'warn' && l.message.includes('not configured')));
  });

  it('soft-skips when the checkout path does not exist on disk', async () => {
    const ctx = fakeCtx();
    let spawnCalled = false;
    const spawnFn: SpawnFn = () => { spawnCalled = true; return makeFakeChild(); };

    await runVercelRedeploy(ctx, { checkoutPath: '/definitely/not/a/real/path/xyz', spawnFn });

    assert.equal(spawnCalled, false);
    assert.ok(ctx.logs.some((l) => l.level === 'warn' && l.message.includes('does not exist')));
  });

  it('spawns vercel --prod --yes in the checkout dir and logs success with the deploy URL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vercel-redeploy-'));
    const ctx = fakeCtx();
    let calledCwd: string | undefined;
    const spawnFn: SpawnFn = (cwd) => {
      calledCwd = cwd;
      return makeFakeChild({ stdout: 'Vercel CLI 54.20.0\nhttps://ryankrol-co-uk.vercel.app\n', exitCode: 0 });
    };

    await runVercelRedeploy(ctx, { checkoutPath: dir, spawnFn });

    assert.equal(calledCwd, dir);
    assert.ok(ctx.logs.some((l) => l.message.includes('Deploy succeeded') && l.message.includes('https://ryankrol-co-uk.vercel.app')));
  });

  it('throws on a non-zero exit code, including captured stderr', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vercel-redeploy-'));
    const ctx = fakeCtx();
    const spawnFn: SpawnFn = () => makeFakeChild({ stderr: 'Error: not authenticated\n', exitCode: 1 });

    await assert.rejects(
      () => runVercelRedeploy(ctx, { checkoutPath: dir, spawnFn }),
      /exited with code 1/,
    );
  });

  it('throws when the child process itself errors (e.g. vercel binary not found)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vercel-redeploy-'));
    const ctx = fakeCtx();
    const spawnFn: SpawnFn = () => makeFakeChild({ emitError: new Error('ENOENT') });

    await assert.rejects(() => runVercelRedeploy(ctx, { checkoutPath: dir, spawnFn }), /ENOENT/);
  });

  it('kills the child and throws on timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vercel-redeploy-'));
    const ctx = fakeCtx();
    let killed = false;
    const spawnFn: SpawnFn = () => {
      const child = new EventEmitter() as unknown as ChildProcess;
      (child as unknown as { stdout: unknown }).stdout = new EventEmitter();
      (child as unknown as { stderr: unknown }).stderr = new EventEmitter();
      // Real OS process reaping emits 'close' once the kill signal lands — simulate that
      // instead of hanging forever, or the runVercelRedeploy promise never settles.
      (child as unknown as { kill: (signal: string) => void }).kill = () => {
        killed = true;
        setImmediate(() => child.emit('close', null));
      };
      // No 'close' until kill() above fires — simulates a hang until the timeout kills it.
      return child;
    };

    await assert.rejects(
      () => runVercelRedeploy(ctx, { checkoutPath: dir, spawnFn, timeoutMs: 10 }),
      /timed out after 10ms/,
    );
    assert.equal(killed, true);
  });

  it('streams stdout/stderr lines to ctx.log as they arrive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vercel-redeploy-'));
    const ctx = fakeCtx();
    const spawnFn: SpawnFn = () => makeFakeChild({ stdout: 'Building...\nUploading...\n', exitCode: 0 });

    await runVercelRedeploy(ctx, { checkoutPath: dir, spawnFn });

    assert.ok(ctx.logs.some((l) => l.message.includes('Building...')));
    assert.ok(ctx.logs.some((l) => l.message.includes('Uploading...')));
  });
});
