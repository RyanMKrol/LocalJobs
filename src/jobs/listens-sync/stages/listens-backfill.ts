import { callService } from '../../../core/services.js';
import { isWorkItemDone, markWorkItem, workItemCounts } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import { dynamoPut } from '../../../services/dynamodb.service.js';
import { listensConfig } from '../config.js';
import type { LastFmRecentTracksResponse, LastFmTrack } from '../types.js';
import {
  makeTrackId,
  makeScrobbleKey,
  normaliseTrack,
  type DynamoPutter,
  type LastFmFetcher,
} from './listens-sync.js';

// The backfill shares the same work_items ledger as the live sync so scrobbles
// synced by either path are never double-written.
const JOB_NAME = 'lastfm-sync';
const MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// Backfill-specific Last.fm fetcher — no `from` param, walks full history
// ---------------------------------------------------------------------------

export function makeBackfillFetcher(apiKey: string, username: string): LastFmFetcher {
  return async (page: number) => {
    const params = new URLSearchParams({
      method: 'user.getRecentTracks',
      user: username,
      api_key: apiKey,
      format: 'json',
      limit: String(listensConfig.lastFmPageSize),
      page: String(page),
    });
    const url = `${listensConfig.lastFmApiBase}/?${params}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Last.fm API error ${res.status}: ${await res.text()}`);
    }
    return res.json() as Promise<LastFmRecentTracksResponse>;
  };
}

// ---------------------------------------------------------------------------
// Core backfill logic
// ---------------------------------------------------------------------------

export async function runListensBackfill(
  ctx: JobContext,
  opts: {
    fetchPage?: LastFmFetcher;
    putItem?: DynamoPutter;
    listensTable?: string;
  } = {},
): Promise<void> {
  const apiKey = process.env.LAST_FM_API_KEY ?? '';
  const username = process.env.LAST_FM_USERNAME ?? '';
  if (!apiKey) throw new Error('LAST_FM_API_KEY is not set');
  if (!username) throw new Error('LAST_FM_USERNAME is not set');

  const listensTable = opts.listensTable ?? process.env.LISTENS_TABLE ?? 'Listens';

  const fetchPage = opts.fetchPage ?? makeBackfillFetcher(apiKey, username);
  const putItem =
    opts.putItem ??
    ((table: string, item: Record<string, unknown>) =>
      callService('dynamodb', () => dynamoPut(table, item)));

  ctx.log(
    `info: listens-backfill starting — user: ${username}, table: ${listensTable}`,
  );
  ctx.log('info: walking full Last.fm history (no time window) — this may take many pages');

  const counts = workItemCounts(JOB_NAME);
  ctx.log(
    `info: ledger before backfill: ${counts['success'] ?? 0} already synced, ${counts['failed'] ?? 0} failed previously`,
  );

  // Paginate through the ENTIRE Last.fm history, paced via the lastfm service.
  // Process page-by-page to keep memory bounded and write progress live.
  let page = 1;
  let totalPages = 1;
  let grandSynced = 0;
  let grandSkipped = 0;
  let grandFailed = 0;

  do {
    ctx.log(`info: fetching page ${page}${totalPages > 1 ? `/${totalPages}` : ''}…`);
    const data = await callService('lastfm', () => fetchPage(page));
    const attr = data.recenttracks['@attr'];
    totalPages = Number(attr.totalPages);

    const rawTracks: LastFmTrack[] = data.recenttracks.track;

    // Filter now-playing (no date) and tracks with no valid timestamp.
    const scrobbled = rawTracks.filter((t) => {
      if (t['@attr']?.nowplaying) return false;
      if (!t.date?.uts || Number(t.date.uts) === 0) return false;
      return true;
    });

    ctx.log(
      `info: page ${page}/${totalPages} — ${scrobbled.length} scrobbles (${rawTracks.length - scrobbled.length} filtered)`,
    );

    let pageSynced = 0;
    let pageSkipped = 0;
    let pageFailed = 0;

    for (const track of scrobbled) {
      const scrobbledAt = Number(track.date!.uts);
      const trackId = makeTrackId(track.artist['#text'], track.name);
      const scrobbleKey = makeScrobbleKey(trackId, scrobbledAt);

      if (isWorkItemDone(JOB_NAME, scrobbleKey, MAX_RETRIES)) {
        pageSkipped++;
        continue;
      }

      try {
        const item = normaliseTrack(track);
        await putItem(listensTable, item as unknown as Record<string, unknown>);
        markWorkItem(JOB_NAME, scrobbleKey, 'success');
        pageSynced++;
        grandSynced++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.log(`error: failed to sync ${scrobbleKey}: ${msg}`);
        markWorkItem(JOB_NAME, scrobbleKey, 'failed');
        pageFailed++;
        grandFailed++;
      }
    }

    grandSkipped += pageSkipped;
    ctx.log(
      `info: page ${page}/${totalPages} done — synced ${pageSynced}, skipped ${pageSkipped} already done, failed ${pageFailed}; totals so far: ${grandSynced} synced / ${grandSkipped} skipped / ${grandFailed} failed`,
    );
    ctx.progress((page / totalPages) * 100, `page ${page}/${totalPages}`);
    page++;
  } while (page <= totalPages);

  ctx.log(
    `info: listens-backfill complete — ${totalPages} page(s) walked; synced ${grandSynced}, skipped ${grandSkipped} already done, failed ${grandFailed}`,
  );

  if (grandFailed > 0) {
    throw new Error(`${grandFailed} scrobble(s) failed during backfill — re-run to retry`);
  }
}
