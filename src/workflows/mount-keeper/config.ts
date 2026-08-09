/**
 * Config for the mount-keeper workflow. The share list is DELIBERATELY
 * env-only with no committed default: this repo is public and the NAS
 * hostname/user/share names describe the owner's machine topology (same rule
 * as plex-rename's PLEX_RENAME_PATH_MAP). An empty list makes the job a
 * loud-logged no-op. This workflow reads no files and writes no data/ output,
 * so there is no dataDir here (nothing for the resolveWorkflowDataDir test
 * guard to protect).
 */
export const mountKeeperConfig = {
  /** smb:// URLs joined by ';' — see parseShares in lib.ts and .env.example. */
  sharesRaw: process.env.MOUNT_KEEPER_SHARES,
};
