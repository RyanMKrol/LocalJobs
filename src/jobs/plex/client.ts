import http from 'node:http';
import https from 'node:https';
import { plexConfig } from './config.js';

/**
 * Plex runs on a SELF-SIGNED cert, so its HTTPS requests need a scoped agent with
 * `rejectUnauthorized: false`. We confine that to Plex requests ONLY (this one
 * agent) and NEVER touch the global `NODE_TLS_REJECT_UNAUTHORIZED` — TMDB and any
 * other host keep full TLS verification.
 */
const insecurePlexAgent = new https.Agent({ rejectUnauthorized: false });

/**
 * GET a Plex API path and parse the JSON body. We request `Accept:
 * application/json` so section items arrive under `MediaContainer.Metadata` (the
 * JSON shape) rather than the XML `Directory` shape. The token is sent as the
 * `X-Plex-Token` query param. Throws a clear, actionable error when PLEX_HOST is
 * unset or unreachable.
 */
export async function plexGet<T = unknown>(path: string): Promise<T> {
  if (!plexConfig.host) {
    throw new Error('Plex unreachable — set PLEX_HOST in .env (e.g. https://192.168.1.x:32400).');
  }
  if (!plexConfig.token) {
    throw new Error('Plex token missing — set PLEX_API_TOKEN in .env.');
  }
  const url = new URL(path, plexConfig.host);
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
      reject(new Error(`Plex unreachable at ${plexConfig.host} — ${e instanceof Error ? e.message : e}. Check PLEX_HOST / that the server is awake.`)),
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
