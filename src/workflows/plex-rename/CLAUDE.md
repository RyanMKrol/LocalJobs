# CLAUDE.md — src/workflows/plex-rename/

Years of accumulated release-named files (`[Erai-raws] Mob Psycho 100 II - 05 [1080p].mkv`,
`10.Cloverfield.Lane.2016.2160p...`) were matched in Plex only via manual fix-ups. If the Plex
database were ever lost, none of that matching is reproducible from the filenames. This workflow
renames files/folders to the canonical Plex conventions — `Title (Year) {tmdb-N}/Title (Year)
{tmdb-N}.ext` for movies, `Show (Year) {tvdb-N}/Season NN/Show (Year) - sNNeNN - Title.ext` for TV,
plus a `.plexmatch` per show folder — using **Plex's own current matches as the source of truth**, so
the library becomes deterministically re-discoverable from disk alone.

## Safety doctrine (the owner's hard requirements — never weaken these)

1. **Never delete content that isn't verifiably replicated — and never rewrite bytes without
   verification.** Two move strategies (2026-08), chosen per move by whether bytes actually travel:
   - **Same-share (and not case-only) → ONE atomic rename** (`performAtomicRenameMove`): metadata
     only, the file's bytes are never read or rewritten, so there is nothing that CAN corrupt and
     nothing to checksum — and it's instant, which is what makes the ~26k same-share bulk of the
     library finishable in days instead of months of I/O. Crash-safe inherently (rename is atomic;
     the file is always fully at exactly one path). Space/utilization checks are skipped — a
     rename consumes no space.
   - **Cross-share (or case-only) → copy → checksum-verify → delete-original**
     (`performVerifiedMove`): stream-copy to `<target>.plexrename-partial` (never a media
     extension, so Plex can't scan a half-copy), SHA-256 both sides, atomically finalize
     partial → target, and ONLY then delete the source. The journal's copy-verified record is
     written before any delete is eligible. Worst crash outcome = a dead extra file, never a
     lost one.
   The journal records each move op's `strategy`, and the undo script reverses each the way it
   was applied (rename back / verified copy back).
2. **Write-AHEAD journal.** Intent is appended + fsync'd to the per-run NDJSON journal BEFORE each
   filesystem operation runs; completion records after. Ledger success is only recorded after the
   journal's item-done is flushed. (This is deliberately stronger than plex-language-fix's
   write-behind applied-log.)
3. **Hard per-op state gates.** Before every operation, apply re-asserts the disk is exactly as
   expected (source present at Plex's recorded size, target absent, mount healthy); after, it
   re-stats and re-hashes. Any surprise aborts the item — never "probably fine".
   The **volume-overburden guard** is part of this: a move soft-skips when the TARGET volume's
   projected utilization after the copy would exceed `PLEX_RENAME_MAX_VOLUME_UTILIZATION`
   (default 92%) — so moves onto a filling volume halt instead of filling it (load-bearing:
   volume1 was measured at 88% when this was added; cross-share consolidation adds data to a
   target volume permanently). The absolute free-space margin check still applies too.
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

- **discover** — LIVE library walk (deliberately NEVER cached, unlike plex-language-fix's 3h-cached
  reads: a rename pipeline must not plan off a stale listing — `lib.ts`'s fetch helpers pass no
  cacheKey). Records one SNAPSHOT row per physical file, re-marked every run: path, `Part.size`,
  tmdb/tvdb/imdb ids off the item's own Guids, movie year/edition, episode numbering/titles/
  air-dates. Multi-episode files are grouped by shared Part id into one row (keyed by the FIRST
  leaf's ratingKey) listing every episode. Library roots come from Plex's own section `Location`
  paths — no env var. `inputKeys()` = the same live walk (T485), `inputKeysService: 'plex'`.
  **Snapshot ledgers self-prune (2026-08-11):** discover/plan/verify each end an UNLIMITED run by
  deleting their own rows whose keys this run didn't re-mark (`pruneSnapshotRows` in store) —
  keys that stop being emitted are GHOSTS (found live: pre-grouping-fix double-episode rows
  lingered and re-noised every apply run as "source no longer present" soft-skips). Limited runs
  never prune (they only re-mark selected roots), and the once-ever apply/confirm ledgers are
  NEVER pruned — deleting those rows would re-arm already-done mutations.
- **plan** — pure naming-engine computation (`naming.ts`), recomputed every run (plans are derived
  state). No disk, no Plex. Passes `siblings: []` — sidecar enumeration is verify's job, because
  directory listings are a FILESYSTEM fact. Cross-item collision pass (`finalizePlan`) downgrades
  duplicate targets deterministically. Detail carries from → to per item (the StageIoPanel report
  the owner reviews during probation).
- **verify** — the only fs-touching read stage (via `callService('fs', ...)` through the injectable
  `ReadFsSeam`). Mount preflight per `PLEX_RENAME_PATH_MAP` pair; maps Plex-side → local paths;
  asserts BOTH sides' shares are mounted + healthy (cross-share consolidation moves are
  legitimate — see the home-root rule below), source exists at exactly Plex's recorded size, mtime ≥
  `PLEX_RENAME_MIN_AGE_DAYS` (default 7 — the still-downloading guard: downloads land directly in
  library folders, so recency is the only in-flight signal), target absent (case-only excepted),
  sidecars enumerated from the REAL listing (`planSidecars`, movie folders also carry fixed-name
  assets; episodes never move release-folder assets into Season dirs), sidecar-target collisions,
  and the `.plexmatch` rules (source-tree hit → ineligible; identical target content → write op
  dropped; divergent → ineligible). Recomputed every run.
- **apply** — the ONLY mutating stage (`stages/apply.ts`). REHEARSAL MODE until
  `PLEX_RENAME_APPLY_ENABLED=1`: same selection + logging + REPORT-ONLY markdown, but no journal,
  no ledger marks, no Butler, zero mutations (a journal file existing always means real intent).
  When enabled: hard mount preflight (any needed share unhealthy → ZERO mutations, nothing marked,
  run success), daily quota via the `job_usage` meter (`PLEX_RENAME_MAX_PER_DAY`, default 30 media
  files; sidecars uncounted; `recordUsage` per applied file), crash reconciliation of any
  unresolved journal BEFORE new work (target-only → roll forward; both-sides-identical → delete
  source after hash equality; divergent/neither → fail loud, never guess), one Plex Butler DB
  backup before the first mutation (WARN-only — it protects the DB, not files), then per item:
  re-check EVERYTHING at the moment of truth (existence, exact size, mtime window, target absent,
  free space for a transient second copy, sidecar targets still clear — any drift is a SOFT skip,
  recomputed next run), journal the full op list, and execute mkdir → write-plexmatch → media
  move → sidecar moves → rmdir-if-empty, each move via `performVerifiedMove` with write-ahead
  journaling per step. Ledger success only after the journal's item-done is flushed; once-ever
  per file. Postamble: per-run report markdown (`data/out/reports/`), targeted
  `plexRefreshSection` per changed dir (falling back to full-section past 30 dirs, WARN-only),
  `run-end`, and a thrown error if any item failed.
- **confirm** — read-only post-verification (`stages/confirm.ts`) that Plex re-associated each
  moved file at the SAME ratingKey (watch state intact). Live fetch per applied-not-yet-confirmed
  item: new path at same key → success (once-ever); old path still → `skipped` (retryable) until
  `PLEX_RENAME_CONFIRM_GRACE_DAYS` (14) past `appliedAt`, then loud failure; ratingKey no longer
  resolving → loud failure immediately (the duplicate-re-import worst case — plex-library-guard
  independently alerts on the vanished key; deliberately NO library-wide search for the new owner
  in v1, the owner investigates). Transient fetch errors are soft skips.

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
- **One folder per show — the home-root consolidation rule (2026-08).** A show split across
  shares (e.g. seasons 1–2 on volume2, 3–5 on volume1) consolidates into ONE folder on its HOME
  root: `chooseShowHomeRoots` picks, per show, the library root already holding the most BYTES of
  it (each file weighs bytes + 1; ties resolve to the lexicographically first root — fully
  deterministic), and `plan` passes it as `RenameInput.homeRootPath`, overriding the file's own
  root for the TARGET. The minority share's files plan cross-share moves — safe because the move
  procedure is copy → verify → delete (never a rename), which crosses filesystems exactly as
  safely as it moves within one, and all bytes route through the Mac over SMB either way. Movies
  are per-item single folders on their own share by construction.
- **Folder strategy:** uniform "move out into a fresh canonical folder, never rename a directory in
  place" — old release folders keep their junk and are listed as leftovers in the report;
  cleanup of folders still HOLDING files is report-only. Emptied dirs
  are removed via plain `rmdir-if-empty` — including the emptied ANCESTOR chain (2026-08-11:
  nested release wrappers like "Mr Robot S01-S04 …/Season S02/" left an empty outer husk once
  drained; apply now climbs bottom-up, journal op carries `stopRoot`), each step structurally
  incapable of deleting files and stopping strictly below the library root. Pre-fix husks (4)
  were swept by hand.

## Undo + journal

`journal.ts`: per-run NDJSON, `JournalWriter` fsyncs every record (and the journal dir at
create); `analyzeJournal` classifies complete/aborted/unresolved for crash recovery.
`move.ts`'s `performVerifiedMove` is the ONLY file-relocation primitive (copy → verify →
finalize → delete-source; case-only renames swap the last two so the verified partial guards
the bytes). `scripts/plex-rename-undo.ts` (manual, never scheduled, dry-run by default,
`--apply` to act) reverses completed ops newest-first with the SAME verified procedure, treats
every surprise as a loud conflict (occupied original, divergent duplicate, hand-edited
`.plexmatch`), and refuses when a journaled mount is absent. It never touches the apply ledger —
reprocessing an undone item is a manual unstick, same doctrine as plex-language-undo.

## Gates (contracts.ts)

discover→plan and apply→confirm are the sanctioned trivial minimum; **plan→verify and
verify→apply are REAL** (T574
pattern): plan's gate asserts every rename row has from ≠ to, target under the file's own library
root, and global collision-freedom; verify's gate asserts every eligible row has both local
paths mapped under configured shares, verified bytes > 0, and a well-formed sidecar list — exactly the malformations apply would
otherwise silently skip, failing loud at the boundary instead.

## Config (`config.ts`)

`PLEX_RENAME_PATH_MAP` (env-ONLY, no committed default — this repo is public and the share names
describe the owner's machine; empty map ⇒ everything `unmapped-path`, nothing can mutate),
`PLEX_RENAME_MIN_AGE_DAYS` (7), `PLEX_RENAME_MAX_PER_DAY` (30 — the daily move quota via the
job_usage meter, owner-raised in .env as trust grows), `PLEX_RENAME_MAX_VOLUME_UTILIZATION` (92 — the volume-overburden cap above),
`PLEX_RENAME_APPLY_ENABLED` (0 — the
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

Every stage's `run*()` takes injectable seams (Plex fetchers / `ReadFsSeam`/`WriteFsSeam` /
ledger readers / quota / `now()`) — tests never touch a live Plex or the real disk (`memfs.ts` is
the shared in-memory write seam; journals go to per-test temp dirs). `naming.test.ts` is the
table-driven engine suite (real-library-shaped cases: anime brackets, Steins;Gate, loose movies,
date-based shows, specials, e100, collisions). Stage tests cover: snapshot re-marking (discover),
decision recomputation + collision downgrades (plan), every verify ineligibility reason including
the mount-missing vs file-missing distinction and all three `.plexmatch` outcomes,
`move.test.ts`'s hook-before-effect ordering + checksum-mismatch + caseOnly ordering,
`journal.test.ts`'s torn-tail tolerance + unresolved classification, `apply.test.ts`'s rehearsal
/ mount-absent / quota / soft-skip / checksum-failure / once-ever / crash-reconciliation-matrix /
refresh-fallback coverage, `confirm.test.ts`'s four outcomes, and the undo script's
conflict-never-overwrite suite (`scripts/plex-rename-undo.test.ts`).
