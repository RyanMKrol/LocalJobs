// check.ts tests — injected state/mount fakes only; never a real mount or osascript.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JobContext } from '../../../core/types.js';
import { parseShares, type MountState, type ShareConfig } from '../lib.js';
import { runCheck, type CheckDetail, type CheckOverrides, type MountStatus } from './check.js';

function fakeCtx(): JobContext {
  return { log() {}, progress() {}, selectedRoots: () => null, rootAllowed: () => true };
}

const SHARE_A: ShareConfig = { url: 'smb://User@nas.local/Share A', mountPoint: '/Volumes/Share A', name: 'Share A' };
const SHARE_B: ShareConfig = { url: 'smb://User@nas.local/Share B', mountPoint: '/Volumes/Share B', name: 'Share B' };

// Every check reports its status through `report`, including one that then fails.
let last: MountStatus | null = null;
const check = (opts: CheckOverrides) => runCheck(fakeCtx(), { ...opts, report: (s) => { last = s; } });

function detailOf(mountPoint: string): { status?: string; detail: CheckDetail } {
  const detail = last?.shares.find((s) => s.mountPoint === mountPoint);
  assert.ok(detail, `expected a reported status for ${mountPoint}`);
  return { status: detail!.action === 'failed' ? 'failed' : 'success', detail: detail! };
}

test('parseShares: smb URLs → mount points; malformed entries dropped', () => {
  const shares = parseShares('smb://User@nas.local/Share A;smb://User@nas.local/Share%20B; not-a-url ;smb://');
  assert.deepEqual(shares.map((s) => s.mountPoint), ['/Volumes/Share A', '/Volumes/Share B'], 'URL-decoded last segment');
  assert.deepEqual(parseShares(undefined), []);
  assert.deepEqual(parseShares(''), []);
});

test('healthy shares are left completely alone', async () => {
  let mountCalls = 0;
  await check({
    shares: [SHARE_A],
    getState: async () => 'healthy',
    mount: async () => {
      mountCalls++;
    },
  });
  assert.equal(mountCalls, 0, 'no mount attempt on a healthy share');
  const d = detailOf(SHARE_A.mountPoint);
  assert.equal(d.status, 'success');
  assert.equal(d.detail.action, 'already-mounted');
});

test('an absent share is remounted and re-verified; a stale empty dir is rmdir-d first', async () => {
  const states = new Map<string, MountState[]>([
    [SHARE_A.mountPoint, ['absent', 'healthy']], // before → after mount
    [SHARE_B.mountPoint, ['stale-empty-dir', 'healthy']],
  ]);
  const mounted: string[] = [];
  const staleRemoved: string[] = [];
  await check({
    shares: [SHARE_A, SHARE_B],
    getState: async (mp) => states.get(mp)!.shift()!,
    removeStale: async (mp) => {
      staleRemoved.push(mp);
      return true;
    },
    mount: async (url) => {
      mounted.push(url);
    },
  });
  assert.deepEqual(mounted, [SHARE_A.url, SHARE_B.url]);
  assert.deepEqual(staleRemoved, [SHARE_B.mountPoint], 'only the stale-empty-dir case triggers the rmdir');
  assert.equal(detailOf(SHARE_A.mountPoint).detail.action, 'remounted');
  assert.equal(detailOf(SHARE_B.mountPoint).detail.action, 'remounted');
});

test('a share that cannot come up fails its row AND the run; a diverted mount is caught', async () => {
  // Mount command throws (NAS off / bad credentials).
  await assert.rejects(
    check({
      shares: [SHARE_A],
      getState: async () => 'absent',
      mount: async () => {
        throw new Error('mount volume failed: timeout');
      },
    }),
    /1\/1 share\(s\) could not be brought up/,
  );
  let d = detailOf(SHARE_A.mountPoint);
  assert.equal(d.status, 'failed');
  assert.match(d.detail.error ?? '', /timeout/);

  // Mount "succeeds" but the expected mount point is still absent → diverted-name suspicion, fail loud.
  const states: MountState[] = ['absent', 'absent'];
  await assert.rejects(
    check({
      shares: [SHARE_A],
      getState: async () => states.shift()!,
      mount: async () => {},
    }),
    /could not be brought up/,
  );
  d = detailOf(SHARE_A.mountPoint);
  assert.equal(d.status, 'failed');
  assert.match(d.detail.error ?? '', /diverted/);

  // A mount point that exists but is NOT a directory is never touched.
  await assert.rejects(
    check({
      shares: [SHARE_A],
      getState: async () => 'not-a-dir',
      mount: async () => {
        throw new Error('must not be called');
      },
    }),
    /could not be brought up/,
  );
  assert.match(detailOf(SHARE_A.mountPoint).detail.error ?? '', /not a directory/);
});

test('no configured shares → loud-logged no-op success', async () => {
  const logs: string[] = [];
  const ctx: JobContext = { log: (m) => logs.push(m), progress() {}, selectedRoots: () => null, rootAllowed: () => true };
  await runCheck(ctx, { shares: [] }); // must not throw
  assert.ok(logs.some((l) => /MOUNT_KEEPER_SHARES is unset/.test(l)));
});

test('snapshot semantics: a share that recovers flips its row back to success on the next run', async () => {
  await assert.rejects(
    check({
      shares: [SHARE_B],
      getState: async () => 'absent',
      mount: async () => {
        throw new Error('down');
      },
    }),
  );
  assert.equal(detailOf(SHARE_B.mountPoint).status, 'failed');

  await check({ shares: [SHARE_B], getState: async () => 'healthy', mount: async () => {} });
  const d = detailOf(SHARE_B.mountPoint);
  assert.equal(d.status, 'success', 'reported afresh every run: the status reflects the current state');
  assert.equal(d.detail.action, 'already-mounted');
});
