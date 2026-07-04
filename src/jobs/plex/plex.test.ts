// Pure-logic tests for the Plex new-seasons audit — NO live Plex/TMDB. Synthetic
// fixtures exercise: GUID extraction, highest-owned-season (exclude season 0),
// highest-aired (exclude future/season-0), the complete-season filter (a season
// whose last episode airs in the future is excluded; a fully-aired one included),
// and that ENDED shows are NOT skipped.
import assert from 'node:assert/strict';
import { enumerateSubnetHosts, resetPlexHostCacheForTests, resolvePlexHost, type PlexProbe } from './client.js';
import { buildShowSnapshots, extractTmdbId, highestOwnedSeasonMap } from './plex.js';
import {
  candidateSeasons,
  completeMissingSeasons,
  evaluateShow,
  highestAiredSeason,
  isSeasonComplete,
} from './tmdb.js';
import { formatSeasonRanges } from './lib.js';
import type {
  PlexEpisodeMeta,
  PlexShow,
  PlexShowMeta,
  TmdbEpisode,
  TmdbSeasonSummary,
  TmdbSeriesDetail,
} from './types.js';

const NOW = new Date('2026-06-24T00:00:00Z');

// ── GUID extraction (always by tmdb:// GUID, never guessed) ──
assert.equal(extractTmdbId([{ id: 'imdb://tt0149460' }, { id: 'tmdb://615' }, { id: 'tvdb://73871' }]), 615);
assert.equal(extractTmdbId([{ id: 'tmdb://9999' }]), 9999);
assert.equal(extractTmdbId([{ id: 'imdb://tt1234567' }]), null, 'no tmdb GUID → null (unverifiable, never guessed)');
assert.equal(extractTmdbId(undefined), null);
assert.equal(extractTmdbId([]), null);
console.log('  ✓ extractTmdbId matches only tmdb:// GUIDs');

// ── highest owned regular season from flat episodes (exclude season 0 specials) ──
const eps: PlexEpisodeMeta[] = [
  { grandparentRatingKey: 'futurama', parentIndex: 1 },
  { grandparentRatingKey: 'futurama', parentIndex: 7 },
  { grandparentRatingKey: 'futurama', parentIndex: 0 }, // specials — must be ignored
  { grandparentRatingKey: 'futurama', parentIndex: 3 },
  { grandparentRatingKey: 'specials-only', parentIndex: 0 },
];
const owned = highestOwnedSeasonMap(eps);
assert.equal(owned.get('futurama'), 7, 'highest owned regular season is 7 (S0 excluded)');
assert.equal(owned.get('specials-only'), undefined, 'a show with only S0 has no regular season');
console.log('  ✓ highestOwnedSeasonMap excludes season 0');

// ── buildShowSnapshots joins shows + episodes ──
const showsMeta: PlexShowMeta[] = [
  { title: 'Futurama', year: 1999, ratingKey: 'futurama', Guid: [{ id: 'tmdb://615' }] },
  { title: 'No GUID Show', ratingKey: 'noguid', Guid: [{ id: 'imdb://tt1' }] },
];
const snaps = buildShowSnapshots(showsMeta, eps);
const fut = snaps.find((s) => s.ratingKey === 'futurama')!;
assert.equal(fut.tmdbId, 615);
assert.equal(fut.highestOwnedSeason, 7);
const noguid = snaps.find((s) => s.ratingKey === 'noguid')!;
assert.equal(noguid.tmdbId, null, 'GUID-less show → tmdbId null (flagged unverifiable downstream)');
assert.equal(noguid.highestOwnedSeason, 0, 'no episodes → highestOwnedSeason 0');
console.log('  ✓ buildShowSnapshots joins shows with owned-season + GUID');

// ── highest AIRED regular season (exclude future + season 0) ──
const seasons: TmdbSeasonSummary[] = [
  { season_number: 0, air_date: '1999-01-01' }, // specials — excluded
  { season_number: 1, air_date: '1999-03-28' },
  { season_number: 7, air_date: '2012-06-20' },
  { season_number: 10, air_date: '2025-09-09' }, // aired (≤ now)
  { season_number: 11, air_date: '2027-01-01' }, // future — excluded
  { season_number: 12, air_date: null }, // dateless — excluded
];
assert.equal(highestAiredSeason(seasons, NOW), 10, 'highest aired is 10 (S11 future, S12 dateless, S0 excluded)');
console.log('  ✓ highestAiredSeason excludes future + dateless + season 0');

// ── candidateSeasons: owned+1..aired ──
assert.deepEqual(candidateSeasons(7, 10), [8, 9, 10]);
assert.deepEqual(candidateSeasons(10, 10), [], 'nothing missing when owned == aired');
assert.deepEqual(candidateSeasons(12, 10), [], 'owned beyond aired → none');
console.log('  ✓ candidateSeasons spans owned+1..aired');

// ── complete-season filter: fully aired in, still-airing out ──
const fullyAired: TmdbEpisode[] = [
  { air_date: '2025-09-01', episode_number: 1 },
  { air_date: '2025-09-08', episode_number: 2 },
];
const midAiring: TmdbEpisode[] = [
  { air_date: '2025-09-01', episode_number: 1 },
  { air_date: '2027-09-08', episode_number: 2 }, // future last episode → still airing
];
const undated: TmdbEpisode[] = [
  { air_date: '2025-09-01', episode_number: 1 },
  { air_date: null, episode_number: 2 }, // an episode not yet scheduled
];
assert.equal(isSeasonComplete(fullyAired, NOW), true, 'every episode aired → complete');
assert.equal(isSeasonComplete(midAiring, NOW), false, 'a future last episode → NOT complete');
assert.equal(isSeasonComplete(undated, NOW), false, 'an undated episode → NOT complete');
assert.equal(isSeasonComplete([], NOW), false, 'empty episode list → NOT complete');
console.log('  ✓ isSeasonComplete excludes still-airing / undated seasons');

// ── end-to-end season math: own S1–7, aired S1–10, S8/9 complete, S10 still airing ──
const seasonEpisodes = new Map<number, TmdbEpisode[]>([
  [8, fullyAired],
  [9, fullyAired],
  [10, midAiring], // released but mid-airing → excluded
]);
const missing = completeMissingSeasons(7, seasons, seasonEpisodes, NOW);
assert.deepEqual(missing, [8, 9], 'S8,S9 complete; S10 mid-airing excluded');
console.log('  ✓ completeMissingSeasons keeps only fully-aired missing seasons');

// ── evaluateShow: ENDED show is NOT skipped (revivals happen) ──
const endedShow: PlexShow & { tmdbId: number } = {
  title: 'Futurama', year: 1999, tmdbId: 615, ratingKey: 'futurama', highestOwnedSeason: 7,
};
const endedDetail: TmdbSeriesDetail = { status: 'Ended', seasons };
const evalEnded = evaluateShow(endedShow, endedDetail, seasonEpisodes, NOW);
assert.ok(evalEnded, 'an Ended show with complete missing seasons is STILL actionable');
assert.equal(evalEnded!.tmdbStatus, 'Ended');
assert.deepEqual(evalEnded!.completeMissingSeasons, [8, 9]);
assert.equal(evalEnded!.highestAiredSeason, 10);
console.log('  ✓ evaluateShow does NOT skip Ended/Canceled shows');

// ── evaluateShow: nothing missing → null ──
const upToDate: PlexShow & { tmdbId: number } = { ...endedShow, highestOwnedSeason: 10 };
assert.equal(evaluateShow(upToDate, endedDetail, new Map(), NOW), null, 'owned == aired → not actionable');
console.log('  ✓ evaluateShow returns null when nothing complete is missing');

// ── season-range formatting for the digest ──
assert.equal(formatSeasonRanges([8, 9, 10]), 'S8–S10');
assert.equal(formatSeasonRanges([4]), 'S4');
assert.equal(formatSeasonRanges([4, 6]), 'S4, S6');
assert.equal(formatSeasonRanges([4, 5, 7]), 'S4–S5, S7');
assert.equal(formatSeasonRanges([10, 8, 9]), 'S8–S10', 'unsorted input is sorted');
console.log('  ✓ formatSeasonRanges compacts contiguous seasons');

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

console.log('  ✓ plex pure-logic tests passed');
