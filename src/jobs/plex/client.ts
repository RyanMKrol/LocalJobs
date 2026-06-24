import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import { plexConfig } from './config.js';

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
  /** Override the configured host (defaults to plexConfig.host). */
  configuredHost?: string;
  /** Override the required machine identifier (defaults to plexConfig.machineId). */
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
  const configuredHost = deps.configuredHost ?? plexConfig.host;
  const machineId = deps.machineId ?? plexConfig.machineId;
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
  const candidates = await (deps.candidateHosts ? deps.candidateHosts() : enumerateSubnetHosts());
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
 * Enumerate candidate Plex base URLs across each local IPv4 /24 the machine is on.
 * For every host in the subnet we emit both an https and an http URL on :32400
 * (Plex serves both; https is self-signed → the scoped insecure agent). The local
 * subnets are derived from `os.networkInterfaces()`.
 */
export function enumerateSubnetHosts(): string[] {
  const prefixes = new Set<string>();
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const ni of ifaces ?? []) {
      // Node <18 reports family as the string 'IPv4'; newer as the number 4.
      const isV4 = ni.family === 'IPv4' || (ni.family as unknown) === 4;
      if (!isV4 || ni.internal) continue;
      const octets = ni.address.split('.');
      if (octets.length === 4) prefixes.add(`${octets[0]}.${octets[1]}.${octets[2]}`);
    }
  }
  const hosts: string[] = [];
  for (const prefix of prefixes) {
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
    if (plexConfig.token) url.searchParams.set('X-Plex-Token', plexConfig.token);
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
  if (!plexConfig.token) {
    throw new Error('Plex token missing — set PLEX_API_TOKEN in .env.');
  }
  const host = await resolvePlexHost();
  const url = new URL(path, host);
  url.searchParams.set('X-Plex-Token', plexConfig.token);
  const isHttps = url.protocol === 'https:';
  const mod = isHttps ? https : http;

  return new Promise<T>((resolve, reject) => {
    const req = mod.get(
      url,
      {
        agent: isHttps ? insecurePlexAgent : undefined,
        headers: { Accept: 'application/json' },
        timeout: plexConfig.requestTimeoutMs,
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
    req.on('timeout', () => req.destroy(new Error(`Plex request timed out for ${path} (${plexConfig.requestTimeoutMs}ms)`)));
    req.on('error', (e) =>
      reject(new Error(`Plex unreachable at ${host} — ${e instanceof Error ? e.message : e}. Check PLEX_HOST / that the server is awake.`)),
    );
  });
}

/**
 * GET a TMDB v3 API path with the Bearer token. TMDB has a valid cert (normal
 * fetch + TLS verification). Throws on a non-2xx so the caller can decide whether
 * to skip the show or stop.
 */
export async function tmdbGet<T = unknown>(path: string): Promise<T> {
  if (!plexConfig.tmdbToken) {
    throw new Error('TMDB token missing — set TMDB_API_TOKEN in .env (Bearer token).');
  }
  const res = await fetch(`https://api.themoviedb.org/3${path}`, {
    headers: { Authorization: `Bearer ${plexConfig.tmdbToken}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`TMDB HTTP ${res.status} for ${path}`);
  return (await res.json()) as T;
}
