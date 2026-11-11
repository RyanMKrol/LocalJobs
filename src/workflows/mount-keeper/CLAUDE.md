# CLAUDE.md — src/workflows/mount-keeper/

macOS mounts SMB network shares lazily (a Finder click mounts them) and drops them on reboot —
sometimes on idle too. But `plex-rename` (and anything else reaching the NAS through
`/Volumes/<name>`) needs the shares reliably present when it runs; an absent mount is handled
safely everywhere (a routine skip, never misread as deleted files) but means no forward progress.
This workflow is the availability guarantee: hourly at :45 (`45 * * * *`), so the 04:45 check
ensures fresh mounts right before plex-rename's 05:00 daily run. It's modeled as a workflow —
not a separate launchd agent — deliberately, so the owner can toggle, monitor, and manually run
it from the dashboard like everything else.

## One stage: `mount-keeper-check`

Per share in `MOUNT_KEEPER_SHARES` (env-ONLY, no committed default — this repo is public and the
NAS host/user/share names describe the owner's machine topology, same rule as plex-rename's
`PLEX_RENAME_PATH_MAP`; format: `smb://` URLs joined by `;`, mount point derived as
`/Volumes/<last URL segment, decoded>`):

1. **Health check** — exists + is a directory + NON-EMPTY (`mountState` in `lib.ts`, the same
   rule as plex-rename's `mountHealthy`). Healthy → left completely alone.
2. **Stale empty mountpoint dir** → plain `rmdir` first (`removeStaleMountDir` — cannot delete
   files by construction). This matters: with a leftover empty dir at `/Volumes/<name>`, macOS
   silently mounts the share at `/Volumes/<name> - 1` instead, breaking every configured path
   while looking "mounted". A mount point that exists but is NOT a directory is never touched —
   loud failure, manual investigation.
3. **Mount** via `osascript -e 'mount volume "<url>"'` (`realMount`) — the same mechanism Finder
   uses, authenticating from the login **Keychain** (the owner's NAS credentials are already
   there from mounting by hand). No password is ever stored or read by this repo. Works because
   the daemon runs as a GUI-session launchd agent.
4. **Re-verify** the mount point is healthy afterwards; a "successful" mount that leaves the
   expected path unhealthy is flagged as a probably-diverted mount name and fails loud.

## How the stage hands over its result (ports)

| Stage | Inputs | Outputs |
|---|---|---|
| `mount-keeper-check` | none | `status` (`mount-status`, inline) |

The artifact type is declared in `stages/check.job.ts` (there is no `contracts.ts`). The value
is `{ checkedAt, healthy, remounted, failed, shares: [{ name, url, mountPoint, action:
already-mounted|remounted|failed, stateBefore, error?, at }] }`, and each share is listed as an
item on the run page. It is committed even when a share could not be brought up: the check hands
it over before throwing, so a failed run's page still shows which share was the problem. The run
then fails, so the workflow notification fires. With no shares configured it logs a warning,
commits an empty status and succeeds.

There is no ledger and no `data/` folder. Every run reports the current state of every share
afresh. Not limitable (no `inputKeys()`). `timeoutMs` 5 minutes, `maxRetries: 2`. The `osascript`
mount call has its own 60 second timeout. The health check and the `rmdir` go through the shared
`fs` service (`callService('fs', ...)`).

While the NAS is really down, the hourly schedule means a failure push every hour. If that is
too noisy during planned NAS downtime, turn the workflow (or just its notifications) off from
the dashboard, and back on afterwards.

## Testing

`stages/check.test.ts` — injected `getState`/`mount`/`removeStale` seams only (never a real
mount/osascript): healthy-untouched, remount + re-verify, stale-dir rmdir ordering, mount-throw
and diverted-name and not-a-dir failures, empty-config no-op, and a share that failed on one run
being reported healthy on the next.
`parseShares` is covered directly (URL-decoding, malformed-entry dropping).
