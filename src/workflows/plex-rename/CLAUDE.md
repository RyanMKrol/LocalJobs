# CLAUDE.md — src/workflows/plex-rename/

Years of accumulated release-named files (`[Erai-raws] Mob Psycho 100 II - 05 [1080p].mkv`,
`10.Cloverfield.Lane.2016.2160p...`) were matched in Plex only via manual fix-ups. If the Plex
database were ever lost, none of that matching is reproducible from the filenames. This workflow
renames files/folders to the canonical Plex conventions — `Title (Year) {tmdb-N}/Title (Year)
{tmdb-N}.ext` for movies, `Show (Year) {tvdb-N}/Season NN/Show (Year) - sNNeNN - Title.ext` for TV,
plus a `.plexmatch` per show folder — using **Plex's own current matches as the source of truth**, so
the library becomes deterministically re-discoverable from disk alone.

## Safety doctrine (the owner's hard requirements — never weaken these)

1. **Never delete content that isn't verifiably replicated.** Every move is
   copy → checksum-verify → delete-original: stream-copy to `<target>.plexrename-partial` (never a
   media extension, so Plex can't scan a half-copy), SHA-256 both sides, atomically finalize
   partial → target, and ONLY then delete the source. The journal's copy-verified record is written
   before any delete is eligible. Worst crash outcome = a dead extra file, never a lost one.
2. **Write-AHEAD journal.** Intent is appended + fsync'd to the per-run NDJSON journal BEFORE each
   filesystem operation runs; completion records after. Ledger success is only recorded after the
   journal's item-done is flushed. (This is deliberately stronger than plex-language-fix's
   write-behind applied-log.)
3. **Hard per-op state gates.** Before every operation, apply re-asserts the disk is exactly as
   expected (source present at Plex's recorded size, target absent, mount healthy); after, it
   re-stats and re-hashes. Any surprise aborts the item — never "probably fine".
4. **Folder removal is structurally incapable of deleting files**: only `rmdir` on a directory a
   fresh `readdir` shows empty, never a library root or ancestor. A half-moved folder (daily quota
   hit mid-folder) keeps its remaining files by construction.
5. **Mount-missing ≠ file-missing.** A mapped share root that's absent OR an empty directory (the
   stale-mountpoint trap) marks items `mount-missing` (routine, zero mutations); `file-missing`
   (mount healthy, file gone) is the alarming one.
6. **Never overwrite, never guess.** Target exists → skip. Metadata ambiguous/unmatched → typed
   skip. Existing `.plexmatch` (source tree, or divergent content at the target) → skip. Non-media
   siblings whose ownership is unclear (a lone `English.srt`) are left behind and reported.

## DAG — 5 stages, all keyed `${ratingKey}::part${partId}`

```
plex-rename-discover → plex-rename-plan → plex-rename-verify → plex-rename-apply → plex-rename-confirm
   (read-only, root)     (read-only)         (read-only, fs)      (MUTATING)          (read-only)
```

(apply + confirm land in a later commit; the manifest currently ends at verify — report-only.)

- **discover** — LIVE library walk (deliberately NEVER cached, unlike plex-language-fix's 3h-cached
  reads: a rename pipeline must not plan off a stale listing — `lib.ts`'s fetch helpers pass no
  cacheKey). Records one SNAPSHOT row per physical file, re-marked every run: path, `Part.size`,
  tmdb/tvdb/imdb ids off the item's own Guids, movie year/edition, episode numbering/titles/
  air-dates. Multi-episode files are grouped by shared Part id into one row (keyed by the FIRST
  leaf's ratingKey) listing every episode. Library roots come from Plex's own section `Location`
  paths — no env var. `inputKeys()` = the same live walk (T485), `inputKeysService: 'plex'`.
- **plan** — pure naming-engine computation (`naming.ts`), recomputed every run (plans are derived
  state). No disk, no Plex. Passes `siblings: []` — sidecar enumeration is verify's job, because
  directory listings are a FILESYSTEM fact. Cross-item collision pass (`finalizePlan`) downgrades
  duplicate targets deterministically. Detail carries from → to per item (the StageIoPanel report
  the owner reviews during probation).
- **verify** — the only fs-touching read stage (via `callService('fs', ...)` through the injectable
  `ReadFsSeam`). Mount preflight per `PLEX_RENAME_PATH_MAP` pair; maps Plex-side → local paths;
  asserts same-share, source exists at exactly Plex's recorded size, mtime ≥
  `PLEX_RENAME_MIN_AGE_DAYS` (default 7 — the still-downloading guard: downloads land directly in
  library folders, so recency is the only in-flight signal), target absent (case-only excepted),
  sidecars enumerated from the REAL listing (`planSidecars`, movie folders also carry fixed-name
  assets; episodes never move release-folder assets into Season dirs), sidecar-target collisions,
  and the `.plexmatch` rules (source-tree hit → ineligible; identical target content → write op
  dropped; divergent → ineligible). Recomputed every run.

## The naming engine (`naming.ts`) — pure, exhaustively table-tested

- **ID policy:** movies prefer `{tmdb-N}` (repo identity convention) falling back to `{imdb-ttN}`;
  shows prefer `{tvdb-N}` falling back to `{tmdb-N}`; **no id → skip `missing-id`** — an unmatched
  title's Plex metadata is filename-derived garbage, and renaming from garbage cements a wrong
  match. Movies also require a year (`missing-year`); shows don't (the folder id carries matching).
- **Sanitizer hazards encoded** (each is a real, documented Plex scanner behaviour): semicolons
  deleted (`Steins;Gate` truncates at `;`), colon → `" - "` with the leading space (`"- "` changes
  the parse), `[ ]` → `( )` (bracket content is Plex's ignore marker), `{ }` deleted (reserved for
  hint tags), NFC normalization (SMB/macOS NFD hazard), 255-byte component budgets (episode titles
  are all-or-nothing: dropped entirely rather than mid-truncated), and the exclusion-filter guard
  (never generate the word "sample" on a <300MB file, never a folder named like Plex's special
  dirs: `Extras`, `Behind The Scenes`, `Plex Versions`, …).
- **Conservative v1 skips:** multi-version items (>1 Media), non-contiguous multi-episode files,
  disc images (VIDEO_TS/BDMV/.iso), anything inside `Plex Versions/` or hidden/system dirs.
  Multi-part (>1 Part on one Media) DOES rename with ` - ptN`. Editions get `{edition-...}` on the
  file name only (folder shared).
- **`.plexmatch`:** identity pins only (title/year + every known id), NO `ep:` lines (canonical
  `sNNeNN` names parse deterministically; per-episode hints couple the file to exact paths).
- **Anime:** names come from Plex's OWN parentIndex/index belief — self-consistent on rescan. If
  Plex's match is wrong, the plan report is the v1 mitigation (garbage-in isn't detectable here).
- **Folder strategy:** uniform "move out into a fresh canonical folder, never rename a directory in
  place" — old release folders keep their junk and are listed as leftovers in the report;
  cleanup is report-only in v1.

## Gates (contracts.ts)

discover→plan is the sanctioned trivial minimum; **plan→verify and verify→apply are REAL** (T574
pattern): plan's gate asserts every rename row has from ≠ to, target under the file's own library
root, and global collision-freedom; verify's gate asserts every eligible row has same-share local
paths, verified bytes > 0, and a well-formed sidecar list — exactly the malformations apply would
otherwise silently skip, failing loud at the boundary instead.

## Config (`config.ts`)

`PLEX_RENAME_PATH_MAP` (env-ONLY, no committed default — this repo is public and the share names
describe the owner's machine; empty map ⇒ everything `unmapped-path`, nothing can mutate),
`PLEX_RENAME_MIN_AGE_DAYS` (7), `PLEX_RENAME_MAX_PER_DAY` (30 — the daily move quota via the
job_usage meter, owner-raised in .env as trust grows), `PLEX_RENAME_APPLY_ENABLED` (0 — the
probation gate: flipping it is a deliberate .env edit + daemon restart, never a dashboard click),
`PLEX_RENAME_CONFIRM_GRACE_DAYS` (14). Sections reuse `PLEX_MOVIE_SECTION`/`PLEX_TV_SECTION`.
Data dir routes through `resolveWorkflowDataDir` (the mandatory test guard).

## Probation plan (owner-decided)

The workflow runs DAILY report-only: plans + verify verdicts accumulate on the dashboard. The flip
to real applying requires ALL of: (1) daily rename plans reviewed for a while and trusted, (2) the
separate `plex-library-guard` workflow (the independent deletion detector) landed and running,
(3) both NAS shares mounted persistently on the Mini (`/Volumes/NAS-Cool Shared Drive` and
`/Volumes/NAS-Cool Shared Drive - 2` — the second is often NOT mounted), (4)
`PLEX_RENAME_APPLY_ENABLED=1` set in `.env` + daemon kickstart. Quota stays 30/day until earned.

## Testing

Every stage's `run*()` takes injectable seams (Plex fetchers / `ReadFsSeam` / ledger readers /
`now()`) — tests never touch a live Plex or the real disk. `naming.test.ts` is the table-driven
engine suite (real-library-shaped cases: anime brackets, Steins;Gate, loose movies, date-based
shows, specials, e100, collisions). Stage tests cover: snapshot re-marking (discover), decision
recomputation + collision downgrades (plan), and every verify ineligibility reason including the
mount-missing vs file-missing distinction and all three `.plexmatch` outcomes.
