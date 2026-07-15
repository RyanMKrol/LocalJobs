// Pure-logic tests for the shared Plex connectivity client — NO live Plex/TMDB.
import assert from 'node:assert/strict';
import {
  enumerateSubnetHosts,
  extractTmdbId,
  plexRequestTimeoutMs,
  resetPlexHostCacheForTests,
  resolvePlexHost,
  type PlexAllResponse,
  type PlexProbe,
} from './plex-client.js';
import { syncService, updateServiceLimits } from '../db/store.js';

// ── resolvePlexHost: DHCP-resilient host resolution (injected probe, no network) ──
// A fake probe maps host → machineIdentifier; everything else is unreachable (null).
function fakeProbe(plexHosts: Record<string, string>): { probe: PlexProbe; calls: () => number } {
  let calls = 0;
  const probe: PlexProbe = async (host) => {
    calls++;
    return host in plexHosts ? plexHosts[host] : null;
  };
  return { probe, calls: () => calls };
}
const SILENT = () => {};

await (async () => {
  // configured-host-wins: the configured host answers as a Plex → used, no scan.
  resetPlexHostCacheForTests();
  {
    const { probe, calls } = fakeProbe({ 'https://config:32400': 'MID-1' });
    const host = await resolvePlexHost({
      configuredHost: 'https://config:32400',
      machineId: '',
      probe,
      candidateHosts: () => {
        throw new Error('scan must not run when the configured host wins');
      },
      log: SILENT,
    });
    assert.equal(host, 'https://config:32400', 'reachable configured host is used as-is');
    assert.equal(calls(), 1, 'only the configured host is probed');
  }
  console.log('  ✓ resolvePlexHost uses a reachable configured PLEX_HOST');

  // scan-fallback: configured host dead → scan finds the live Plex on the subnet.
  resetPlexHostCacheForTests();
  {
    const { probe } = fakeProbe({ 'https://10.0.0.7:32400': 'MID-9' });
    const host = await resolvePlexHost({
      configuredHost: 'https://stale:32400', // unreachable
      machineId: '',
      probe,
      candidateHosts: () => ['https://10.0.0.5:32400', 'https://10.0.0.7:32400', 'http://10.0.0.7:32400'],
      log: SILENT,
    });
    assert.equal(host, 'https://10.0.0.7:32400', 'scan returns the first answering Plex');
  }
  console.log('  ✓ resolvePlexHost falls back to a LAN scan when PLEX_HOST is stale');

  // machine-id gating: scan rejects a Plex whose id ≠ PLEX_MACHINE_ID, accepts the match.
  resetPlexHostCacheForTests();
  {
    const { probe } = fakeProbe({
      'https://10.0.0.5:32400': 'OTHER-PLEX', // a different Plex — must be rejected
      'https://10.0.0.8:32400': 'WANTED-ID', // the right one
    });
    const host = await resolvePlexHost({
      configuredHost: '',
      machineId: 'WANTED-ID',
      probe,
      candidateHosts: () => ['https://10.0.0.5:32400', 'https://10.0.0.8:32400'],
      log: SILENT,
    });
    assert.equal(host, 'https://10.0.0.8:32400', 'only the matching machineIdentifier is accepted');
  }
  // and a configured host that is the WRONG Plex is not latched onto.
  resetPlexHostCacheForTests();
  {
    const { probe } = fakeProbe({
      'https://config:32400': 'WRONG', // configured host is a Plex, but the wrong one
      'https://10.0.0.8:32400': 'WANTED-ID',
    });
    const host = await resolvePlexHost({
      configuredHost: 'https://config:32400',
      machineId: 'WANTED-ID',
      probe,
      candidateHosts: () => ['https://10.0.0.8:32400'],
      log: SILENT,
    });
    assert.equal(host, 'https://10.0.0.8:32400', 'a wrong-machine configured host is rejected, scan wins');
  }
  console.log('  ✓ resolvePlexHost respects PLEX_MACHINE_ID (rejects the wrong Plex)');

  // caching: resolve once per process — a second call probes nothing further.
  resetPlexHostCacheForTests();
  {
    const { probe, calls } = fakeProbe({ 'https://config:32400': 'MID-1' });
    const first = await resolvePlexHost({ configuredHost: 'https://config:32400', machineId: '', probe, log: SILENT });
    const callsAfterFirst = calls();
    const second = await resolvePlexHost({
      configuredHost: 'https://config:32400',
      machineId: '',
      probe,
      candidateHosts: () => {
        throw new Error('cached resolve must not re-scan');
      },
      log: SILENT,
    });
    assert.equal(second, first, 'second resolve returns the cached host');
    assert.equal(calls(), callsAfterFirst, 'cached resolve probes nothing further');
  }
  console.log('  ✓ resolvePlexHost caches the resolved host for the process');

  // not-found: nothing answers → the clear, actionable "set PLEX_HOST" error.
  resetPlexHostCacheForTests();
  {
    const { probe } = fakeProbe({});
    await assert.rejects(
      resolvePlexHost({
        configuredHost: 'https://dead:32400',
        machineId: '',
        probe,
        candidateHosts: () => ['https://10.0.0.1:32400', 'https://10.0.0.2:32400'],
        log: SILENT,
      }),
      /set PLEX_HOST/,
      'no Plex anywhere → clear set-PLEX_HOST error',
    );
  }
  resetPlexHostCacheForTests();
  console.log('  ✓ resolvePlexHost throws the clear error when no Plex is found');
})();

// ── enumerateSubnetHosts: excludes virtual/VPN interfaces, prioritizes the
//    configured host's subnet (T402) ──
{
  const fixture = {
    en0: [{ address: '192.168.1.50', family: 'IPv4', internal: false }],
    utun3: [{ address: '100.64.0.5', family: 'IPv4', internal: false }],
    tailscale0: [{ address: '100.100.0.9', family: 'IPv4', internal: false }],
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  } as unknown as NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>;

  const hosts = enumerateSubnetHosts({ interfaces: fixture });
  assert.ok(hosts.some((h) => h.includes('192.168.1.')), 'real LAN interface subnet is scanned');
  assert.ok(!hosts.some((h) => h.includes('100.64.0.')), 'utun (Tailscale) subnet is excluded');
  assert.ok(!hosts.some((h) => h.includes('100.100.0.')), 'tailscale0 subnet is excluded');
  console.log('  ✓ enumerateSubnetHosts excludes known-virtual/VPN interfaces by name');
}

{
  const fixture = {
    en0: [{ address: '192.168.1.50', family: 'IPv4', internal: false }],
    en1: [{ address: '10.0.0.5', family: 'IPv4', internal: false }],
  } as unknown as NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>;

  const hosts = enumerateSubnetHosts({ interfaces: fixture, preferredHost: 'https://10.0.0.99:32400' });
  const firstPreferredIdx = hosts.findIndex((h) => h.includes('10.0.0.'));
  const firstOtherIdx = hosts.findIndex((h) => h.includes('192.168.1.'));
  assert.ok(firstPreferredIdx !== -1 && firstOtherIdx !== -1, 'both subnets produced candidates');
  assert.ok(firstPreferredIdx < firstOtherIdx, "configured host's subnet is ordered first");
  console.log("  ✓ enumerateSubnetHosts prioritizes the configured host's own subnet first");
}

{
  // No configured host / prefix not among candidates → no prioritization, no crash.
  const fixture = {
    en0: [{ address: '192.168.1.50', family: 'IPv4', internal: false }],
    en1: [{ address: '10.0.0.5', family: 'IPv4', internal: false }],
  } as unknown as NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>;

  const withoutPreferred = enumerateSubnetHosts({ interfaces: fixture });
  assert.equal(withoutPreferred.length, 254 * 2 * 2, 'both subnets fully enumerated with no preference applied');

  const withUnmatchedPreferred = enumerateSubnetHosts({ interfaces: fixture, preferredHost: 'https://172.16.0.1:32400' });
  assert.equal(withUnmatchedPreferred.length, 254 * 2 * 2, 'unmatched preferred prefix does not crash or drop candidates');
  console.log('  ✓ enumerateSubnetHosts behaves unchanged with no matching preferred subnet');
}

{
  // plexRequestTimeoutMs (T465): a dashboard override of the `plex` service's
  // timeout_ms takes effect WITHOUT touching PLEX_REQUEST_TIMEOUT_MS/any env var.
  const before = plexRequestTimeoutMs();
  syncService({ name: 'plex' }); // ensure a services row exists (registry does this in production)
  updateServiceLimits('plex', { rate_per_minute: null, daily_cap: null, monthly_cap: null, timeout_ms: 111_222 });
  assert.equal(plexRequestTimeoutMs(), 111_222, 'a dashboard override changes the effective Plex timeout');
  assert.notEqual(before, 111_222, 'the override value differs from whatever the code default was');

  // Clearing the override reverts to the code default (the env-derived constant).
  updateServiceLimits('plex', { rate_per_minute: null, daily_cap: null, monthly_cap: null, timeout_ms: null });
  assert.equal(plexRequestTimeoutMs(), before, 'clearing the override reverts to the code default');
  console.log('  ✓ plexRequestTimeoutMs: dashboard override wins over the env/code default');
}

// ── extractTmdbId: the single shared GUID-extraction implementation (T586) ──
{
  assert.equal(
    extractTmdbId([{ id: 'imdb://tt0468569' }, { id: 'tmdb://155' }, { id: 'tvdb://16' }]),
    155,
    'a title with a tmdb:// GUID returns the numeric id',
  );
  assert.equal(
    extractTmdbId([{ id: 'imdb://tt0468569' }, { id: 'tvdb://16' }]),
    null,
    'a title with no tmdb:// GUID returns null (never guessed)',
  );
  assert.equal(extractTmdbId(undefined), null, 'no GUID array at all → null');
  assert.equal(extractTmdbId([]), null, 'an empty GUID array → null');
  console.log('  ✓ extractTmdbId: present tmdb:// GUID → id, absent → null');
}

// ── PlexAllResponse<T> typing round-trip (T586) ──
{
  interface FakeTitle { title: string; ratingKey: string }
  const populated: PlexAllResponse<FakeTitle> = {
    MediaContainer: { Metadata: [{ title: 'Heat', ratingKey: '1' }] },
  };
  assert.equal(populated.MediaContainer?.Metadata?.[0]?.title, 'Heat');

  const empty: PlexAllResponse<FakeTitle> = { MediaContainer: {} };
  assert.deepEqual(empty.MediaContainer?.Metadata ?? [], []);

  const missing: PlexAllResponse<FakeTitle> = {};
  assert.deepEqual(missing.MediaContainer?.Metadata ?? [], []);
  console.log('  ✓ PlexAllResponse<T> round-trips a populated/empty/missing MediaContainer shape');
}

console.log('  ✓ plex-client pure-logic tests passed');
