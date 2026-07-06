import http from 'node:http';
import https from 'node:https';
import os from 'node:os';

/**
 * Shared Plex + TMDB connectivity helper — used by every Plex-touching workflow
 * (`missing-tv-seasons`, `tv-recommendations`, `movie-recommendations`,
 * `plex-space-saver`), not owned by any single one of them. Self-contained: reads
 * its own env vars directly, imports nothing from a workflow's `config.ts`
 * (mirroring how `src/services/*.service.ts` and `src/core/browser.ts` are
 * self-contained).
 */
const PLEX_HOST = process.env.PLEX_HOST ?? '';
const PLEX_API_TOKEN = process.env.PLEX_API_TOKEN ?? '';
const PLEX_MACHINE_ID = process.env.PLEX_MACHINE_ID ?? '';
const PLEX_REQUEST_TIMEOUT_MS = Number(process.env.PLEX_REQUEST_TIMEOUT_MS ?? 300_000);
/** Bearer token. Accept the legacy TVDB_API_TOKEN name as a fallback. */
const TMDB_API_TOKEN = process.env.TMDB_API_TOKEN ?? process.env.TVDB_API_TOKEN ?? '';

/**
 * Plex runs on a SELF-SIGNED cert, so its HTTPS requests need a scoped agent with
 * `rejectUnauthorized: false`. We confine that to Plex requests ONLY (this one
 * agent) and NEVER touch the global `NODE_TLS_REJECT_UNAUTHORIZED` — TMDB and any
 * other host keep full TLS verification.
 */
const insecurePlexAgent = new https.Agent({ rejectUnauthorized: false });

// ── Host resolution (self-heals a changed DHCP IP via a LAN scan) ──────────────
//
// The owner's Plex server gets its IP via DHCP, so a hardcoded PLEX_HOST goes
// stale whenever the lease changes — which used to break the whole workflow at the
// snapshot stage. `resolvePlexHost()` makes the client resilient: it confirms the
// configured PLEX_HOST is actually a live Plex (and, if PLEX_MACHINE_ID is set,
// the RIGHT one) and otherwise scans the local /24 subnet for a Plex on :32400.
// The resolved host is cached for the process (resolve at most once per daemon run).

/** Per-probe network timeout — short so a dead host fails fast during a scan. */
const PROBE_TIMEOUT_MS = Number(process.env.PLEX_PROBE_TIMEOUT_MS ?? 1_500);
/** How many subnet hosts to probe at once during a scan. */
const SCAN_CONCURRENCY = Number(process.env.PLEX_SCAN_CONCURRENCY ?? 32);
/** Overall wall-clock cap on a scan so a no-Plex LAN fails fast, never hangs. */
const SCAN_OVERALL_CAP_MS = Number(process.env.PLEX_SCAN_CAP_MS ?? 20_000);

/**
 * A probe of one candidate base URL. Resolves to the server's `machineIdentifier`
 * (a string — possibly empty if it answered as a Plex but reported no id) when the
 * host answers as a Plex on `/identity`, or `null` when it is unreachable / not a
 * Plex / times out. Injectable so the resolver can be unit-tested without a network.
 */
export type PlexProbe = (host: string, timeoutMs: number) => Promise<string | null>;

interface ResolveDeps {
  /** Override the configured host (defaults to PLEX_HOST). */
  configuredHost?: string;
  /** Override the required machine identifier (defaults to PLEX_MACHINE_ID). */
  machineId?: string;
  /** Override the probe (defaults to the real network `probePlexIdentity`). */
  probe?: PlexProbe;
  /** Override the subnet candidate list (defaults to `enumerateSubnetHosts()`). */
  candidateHosts?: () => string[] | Promise<string[]>;
  probeTimeoutMs?: number;
  concurrency?: number;
  overallCapMs?: number;
  log?: (msg: string, level?: 'info' | 'warn' | 'error') => void;
}

let cachedHost: string | null = null;
let resolving: Promise<string> | null = null;

/** Clear the process-level resolved-host cache (test-only). */
export function resetPlexHostCacheForTests(): void {
  cachedHost = null;
  resolving = null;
}

/**
 * Resolve the Plex base URL to use, caching the result for the process so the scan
 * runs at most once per daemon run. Tries the configured PLEX_HOST first (gated on
 * PLEX_MACHINE_ID when set) and falls back to a bounded LAN scan; throws the clear,
 * actionable "set PLEX_HOST" error when no Plex is found.
 */
export function resolvePlexHost(deps: ResolveDeps = {}): Promise<string> {
  if (cachedHost) return Promise.resolve(cachedHost);
  if (resolving) return resolving;
  resolving = doResolvePlexHost(deps).then(
    (host) => {
      cachedHost = host;
      resolving = null;
      return host;
    },
    (err) => {
      resolving = null;
      throw err;
    },
  );
  return resolving;
}

async function doResolvePlexHost(deps: ResolveDeps): Promise<string> {
  const configuredHost = deps.configuredHost ?? PLEX_HOST;
  const machineId = deps.machineId ?? PLEX_MACHINE_ID;
  const probe = deps.probe ?? probePlexIdentity;
  const probeTimeoutMs = deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const concurrency = deps.concurrency ?? SCAN_CONCURRENCY;
  const overallCapMs = deps.overallCapMs ?? SCAN_OVERALL_CAP_MS;
  const log = deps.log ?? ((m, level) => console[level === 'error' ? 'error' : 'log'](`[plex] ${m}`));

  // 1. Trust the configured host only if it actually answers as the right Plex.
  if (configuredHost) {
    const id = await probe(configuredHost, probeTimeoutMs);
    if (id !== null && (!machineId || id === machineId)) {
      return configuredHost;
    }
    if (id !== null && machineId && id !== machineId) {
      log(
        `Configured PLEX_HOST ${configuredHost} is a Plex but its machineIdentifier (${id}) ≠ PLEX_MACHINE_ID (${machineId}) — scanning for the right server.`,
        'warn',
      );
    } else {
      log(`Configured PLEX_HOST ${configuredHost} did not answer as a Plex — scanning the local subnet.`, 'warn');
    }
  } else {
    log('PLEX_HOST is unset — scanning the local subnet for a Plex server.', 'warn');
  }

  // 2. Scan the local subnet(s) for a Plex on :32400 (gated on machineId when set).
  const candidates = await (deps.candidateHosts
    ? deps.candidateHosts()
    : enumerateSubnetHosts({ preferredHost: configuredHost, log }));
  log(
    `Scanning ${candidates.length} candidate address(es) on :32400 for a Plex server${machineId ? ` (machineIdentifier ${machineId})` : ''}…`,
  );
  const found = await scanForPlexHost(candidates, machineId, probe, probeTimeoutMs, concurrency, overallCapMs);
  if (found) {
    log(`✓ found Plex at ${found} — set PLEX_HOST=${found} in .env to skip the scan next time.`);
    return found;
  }

  throw new Error(
    `Plex unreachable — set PLEX_HOST in .env (e.g. https://192.168.1.x:32400). The LAN scan found no Plex server on :32400${
      machineId ? ` matching PLEX_MACHINE_ID ${machineId}` : ''
    }. Check the server is awake and on this subnet.`,
  );
}

/**
 * Probe candidate hosts with bounded concurrency, returning the first that answers
 * as an accepted Plex (machineId-gated when set), or null. Stops early on the first
 * hit and on the overall wall-clock cap so a no-Plex LAN fails fast.
 */
async function scanForPlexHost(
  candidates: string[],
  machineId: string,
  probe: PlexProbe,
  probeTimeoutMs: number,
  concurrency: number,
  overallCapMs: number,
): Promise<string | null> {
  let index = 0;
  let result: string | null = null;
  const deadline = overallCapMs > 0 ? Date.now() + overallCapMs : Number.POSITIVE_INFINITY;

  async function worker(): Promise<void> {
    while (result === null && index < candidates.length && Date.now() < deadline) {
      const host = candidates[index++];
      const id = await probe(host, probeTimeoutMs);
      if (result !== null) return; // another worker already won
      if (id !== null && (!machineId || id === machineId)) {
        result = host;
        return;
      }
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, candidates.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return result;
}

/**
 * Interface names that can never host the real Plex server — virtual/VPN/tunnel
 * adapters (Tailscale, WireGuard, generic VPN/PPP/IPsec, macOS AirDrop peer-to-peer,
 * Docker/VMware bridges, ZeroTier). Excluding these keeps the scan budget (a fixed
 * 20s wall-clock cap, T149) from being wasted probing addresses that structurally
 * can't answer — on a machine with a VPN interface up, roughly half the scan's 508
 * candidates-per-subnet were previously spent there instead of the real LAN.
 */
const VIRTUAL_INTERFACE_PATTERN = /^(utun|tailscale|wg|ppp|ipsec|awdl|llw|bridge|docker|vmnet|zt)/i;

/** Derive the `a.b.c` /24 prefix from an IPv4 dotted-quad address, or null if malformed. */
function ipv4Prefix(address: string): string | null {
  const octets = address.split('.');
  return octets.length === 4 ? `${octets[0]}.${octets[1]}.${octets[2]}` : null;
}

/** Derive the /24 prefix of a configured Plex host URL's hostname, or null if unavailable. */
function preferredPrefixFromHost(host: string | undefined): string | null {
  if (!host) return null;
  try {
    return ipv4Prefix(new URL(host).hostname);
  } catch {
    return null;
  }
}

interface EnumerateOptions {
  /** The currently-configured (possibly stale) Plex host URL, if any. */
  preferredHost?: string;
  /** Injectable in place of `os.networkInterfaces()` — for tests. */
  interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  log?: (msg: string, level?: 'info' | 'warn' | 'error') => void;
}

/**
 * Enumerate candidate Plex base URLs across each local IPv4 /24 the machine is on,
 * excluding known-virtual/VPN interfaces (see `VIRTUAL_INTERFACE_PATTERN`) and, when
 * a `preferredHost` is given, ordering that subnet's hosts FIRST — a DHCP lease
 * change alters the last octet, not the whole subnet, so the previously-known-good
 * subnet is very likely still the right one even when the specific host no longer
 * answers. For every host in a subnet we emit both an https and an http URL on
 * :32400 (Plex serves both; https is self-signed → the scoped insecure agent).
 */
export function enumerateSubnetHosts(options: EnumerateOptions = {}): string[] {
  const log = options.log ?? (() => {});
  const ifaces = options.interfaces ?? os.networkInterfaces();
  const prefixes = new Set<string>();
  const included: string[] = [];
  const excluded: string[] = [];

  for (const [name, niList] of Object.entries(ifaces)) {
    for (const ni of niList ?? []) {
      // Node <18 reports family as the string 'IPv4'; newer as the number 4.
      const isV4 = ni.family === 'IPv4' || (ni.family as unknown) === 4;
      if (!isV4 || ni.internal) continue;
      if (VIRTUAL_INTERFACE_PATTERN.test(name)) {
        excluded.push(`${name} (${ni.address})`);
        continue;
      }
      const prefix = ipv4Prefix(ni.address);
      if (prefix) {
        prefixes.add(prefix);
        included.push(`${name} (${ni.address})`);
      }
    }
  }

  log(
    `Subnet scan candidate interfaces — included: ${included.length ? included.join(', ') : 'none'}; excluded (virtual/VPN): ${
      excluded.length ? excluded.join(', ') : 'none'
    }.`,
  );

  const preferredPrefix = preferredPrefixFromHost(options.preferredHost);
  const orderedPrefixes = [...prefixes];
  if (preferredPrefix && prefixes.has(preferredPrefix)) {
    orderedPrefixes.sort((a, b) => (a === preferredPrefix ? -1 : b === preferredPrefix ? 1 : 0));
  }

  const hosts: string[] = [];
  for (const prefix of orderedPrefixes) {
    for (let last = 1; last <= 254; last++) {
      hosts.push(`https://${prefix}.${last}:32400`);
      hosts.push(`http://${prefix}.${last}:32400`);
    }
  }
  return hosts;
}

/**
 * Real network probe: GET `<host>/identity` with the X-Plex-Token and return the
 * server's `machineIdentifier` if it answers as a Plex, else null. Never throws —
 * any error/timeout/non-2xx/non-Plex response resolves to null so the scan moves on.
 */
export function probePlexIdentity(host: string, timeoutMs: number): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let url: URL;
    try {
      url = new URL('/identity', host);
    } catch {
      resolve(null);
      return;
    }
    if (PLEX_API_TOKEN) url.searchParams.set('X-Plex-Token', PLEX_API_TOKEN);
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    let settled = false;
    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = mod.get(
      url,
      {
        agent: isHttps ? insecurePlexAgent : undefined,
        headers: { Accept: 'application/json' },
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 400) {
          res.resume();
          done(null);
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body) as { MediaContainer?: { machineIdentifier?: string } };
            const id = parsed?.MediaContainer?.machineIdentifier;
            done(typeof id === 'string' ? id : null);
          } catch {
            done(null);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => done(null));
  });
}

/**
 * GET a Plex API path and parse the JSON body. We request `Accept:
 * application/json` so section items arrive under `MediaContainer.Metadata` (the
 * JSON shape) rather than the XML `Directory` shape. The token is sent as the
 * `X-Plex-Token` query param. The base host is resolved (and cached) via
 * `resolvePlexHost`, which self-heals a changed DHCP IP by scanning the LAN.
 */
export async function plexGet<T = unknown>(path: string): Promise<T> {
  if (!PLEX_API_TOKEN) {
    throw new Error('Plex token missing — set PLEX_API_TOKEN in .env.');
  }
  const host = await resolvePlexHost();
  const url = new URL(path, host);
  url.searchParams.set('X-Plex-Token', PLEX_API_TOKEN);
  const isHttps = url.protocol === 'https:';
  const mod = isHttps ? https : http;

  return new Promise<T>((resolve, reject) => {
    const req = mod.get(
      url,
      {
        agent: isHttps ? insecurePlexAgent : undefined,
        headers: { Accept: 'application/json' },
        timeout: PLEX_REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 400) {
          res.resume();
          reject(new Error(`Plex HTTP ${status} for ${path}`));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body) as T);
          } catch (e) {
            reject(new Error(`Plex non-JSON response for ${path}: ${e instanceof Error ? e.message : e}`));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`Plex request timed out for ${path} (${PLEX_REQUEST_TIMEOUT_MS}ms)`)));
    req.on('error', (e) =>
      reject(new Error(`Plex unreachable at ${host} — ${e instanceof Error ? e.message : e}. Check PLEX_HOST / that the server is awake.`)),
    );
  });
}

/**
 * PUT the default audio/subtitle stream selection for a Plex Part — the SAME
 * documented endpoint Plex's own clients call when a user manually picks a track
 * (`PUT /library/parts/<partId>?audioStreamID=<id>&subtitleStreamID=<id>&allParts=1`).
 * `subtitleStreamId` may be `null` to explicitly select "no subtitle". Uses the
 * same resolved host + scoped insecure-TLS agent as `plexGet` — no second TLS
 * bypass. Throws on a non-2xx so the caller can record the failure.
 */
export async function plexPutStreams(partId: number, audioStreamId: number, subtitleStreamId?: number | null): Promise<void> {
  if (!PLEX_API_TOKEN) {
    throw new Error('Plex token missing — set PLEX_API_TOKEN in .env.');
  }
  const host = await resolvePlexHost();
  const url = new URL(`/library/parts/${partId}`, host);
  url.searchParams.set('X-Plex-Token', PLEX_API_TOKEN);
  url.searchParams.set('audioStreamID', String(audioStreamId));
  if (subtitleStreamId !== undefined && subtitleStreamId !== null) {
    url.searchParams.set('subtitleStreamID', String(subtitleStreamId));
  }
  url.searchParams.set('allParts', '1');
  const isHttps = url.protocol === 'https:';
  const mod = isHttps ? https : http;

  await new Promise<void>((resolve, reject) => {
    const req = mod.request(
      url,
      {
        method: 'PUT',
        agent: isHttps ? insecurePlexAgent : undefined,
        headers: { Accept: 'application/json' },
        timeout: PLEX_REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        res.resume();
        if (status >= 400) {
          reject(new Error(`Plex HTTP ${status} for PUT /library/parts/${partId}`));
          return;
        }
        resolve();
      },
    );
    req.on('timeout', () => req.destroy(new Error(`Plex request timed out for PUT /library/parts/${partId} (${PLEX_REQUEST_TIMEOUT_MS}ms)`)));
    req.on('error', (e) =>
      reject(new Error(`Plex unreachable at ${host} — ${e instanceof Error ? e.message : e}. Check PLEX_HOST / that the server is awake.`)),
    );
    req.end();
  });
}

/**
 * Trigger a Plex Butler on-demand database backup (`POST /butler/BackupDatabase`)
 * — the safety net a mutating run leans on instead of a human reviewing every
 * run. Validated live: produces a real dated backup within about a minute.
 * Never throws — resolves `{ ok: true }` on a 2xx, `{ ok: false, error }`
 * otherwise, so a failed trigger can be logged as a WARN without blocking the
 * caller's mutating work (the per-file undo log is the primary safety net).
 */
export async function triggerButlerBackup(): Promise<{ ok: boolean; error?: string }> {
  if (!PLEX_API_TOKEN) {
    return { ok: false, error: 'Plex token missing — set PLEX_API_TOKEN in .env.' };
  }
  try {
    const host = await resolvePlexHost();
    const url = new URL('/butler/BackupDatabase', host);
    url.searchParams.set('X-Plex-Token', PLEX_API_TOKEN);
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    await new Promise<void>((resolve, reject) => {
      const req = mod.request(
        url,
        {
          method: 'POST',
          agent: isHttps ? insecurePlexAgent : undefined,
          headers: { Accept: 'application/json' },
          timeout: PLEX_REQUEST_TIMEOUT_MS,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          res.resume();
          if (status >= 400) {
            reject(new Error(`Plex HTTP ${status} for POST /butler/BackupDatabase`));
            return;
          }
          resolve();
        },
      );
      req.on('timeout', () => req.destroy(new Error('Plex Butler backup request timed out')));
      req.on('error', (e) => reject(e instanceof Error ? e : new Error(String(e))));
      req.end();
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * GET a TMDB v3 API path with the Bearer token. TMDB has a valid cert (normal
 * fetch + TLS verification). Throws on a non-2xx so the caller can decide whether
 * to skip the show or stop.
 */
export async function tmdbGet<T = unknown>(path: string): Promise<T> {
  if (!TMDB_API_TOKEN) {
    throw new Error('TMDB token missing — set TMDB_API_TOKEN in .env (Bearer token).');
  }
  const res = await fetch(`https://api.themoviedb.org/3${path}`, {
    headers: { Authorization: `Bearer ${TMDB_API_TOKEN}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`TMDB HTTP ${res.status} for ${path}`);
  return (await res.json()) as T;
}
