# CLAUDE.md — src/workflows/vault-sync/

A single-stage mirror that copies the markdown output of five source workflows into the
owner's second-brain vault folder on disk. The vault is the owner's browsable "second
brain"; this workflow is the only thing that writes into it.

## What it does

`vault-sync-export` (the only stage — no DAG edge, no gate needed, mirroring the
`plex-profiles`/`overrides-audit` single-stage precedent) enumerates the `success`
`work_items` rows of the five source jobs via `listSuccessWorkItems` and copies each row's
`detail.markdown` file into the vault:

| Source job | Workflow | Vault folder | Filename rule |
|---|---|---|---|
| `enrich-with-llm` | places | `Places/` | `<detail.name>.md` |
| `perfumes-build` | perfumes | `Perfumes/` | `<detail.name> (<CONC>).md` — concentration from the key's 3rd `__` segment |
| `plex-profiles-build` | plex-profiles | `Plex/Movies/` or `Plex/TV/` (key prefix `movie:`/`show:`) | `<detail.name> (<year>).md` — year read from the source file's frontmatter |
| `lastfm-digest` | listening-digest | `Listening/` | `July 2026.md` / `July 2026 (Trailing 3 Months).md` from the `YYYY-MM[-3month]` key |
| `workouts-progress` | workouts-sync | `Workouts/` | `July 2026.md` from the `YYYY-MM` key |

Names are sanitized (`sanitizeFilename` in `lib.ts` — strips `\/:*?"<>|` + control chars,
caps length, falls back to the item key). A collision between two different items gets a
stable ` (<sanitized source key>)` suffix on the later one.

## Vault location + test guard

`SECOND_BRAIN_VAULT_DIR` env var, defaulting to `~/SecondBrain` via `homedir()` — never a
hardcoded `/Users/...` literal (repo self-containment rule). The path is routed through
`resolveWorkflowDataDir` in `config.ts`, so under `npm test` it redirects to a per-process
temp dir and the suite can never touch the real vault (the same guard every workflow's
dataDir gets). The stage also takes an injectable `vaultDir` opt for tests.

## Mirror semantics (protect these)

- **Copy-only, overwrite-on-change, never delete.** Source files stay in each workflow's
  `data/out`; the vault is a READ-ONLY mirror the owner does not edit, so overwriting is
  always safe. Nothing is ever deleted from the vault — a renamed item leaves its old copy
  behind with a warn log (orphans are log-only), and a source item that later disappears
  just stops being refreshed.
- **Idempotency — the `sourceUpdatedAt` marker.** The exporter's own `work_items` ledger
  keys each item `<sourceJob>::<sourceItemKey>` and stores the source row's `updated_at`
  at copy time. An item is re-copied only when: it has no exporter row yet, the source
  row's `updated_at` has moved (plex-profiles re-marks its row whenever Plex's own
  `updatedAt` moves; listening/workouts re-mark on an in-month re-run), or the vault copy
  was deleted by hand. A steady-state run is a pure DB compare — no file reads, no writes.
- **Workouts per-month files (since 2026-08).** `workouts-progress` writes one file per
  month (`workouts-sync/data/out/workouts-progress-<YYYY-MM>.md`), so every ledger row
  points at its own surviving file and workouts needs no special-casing here. History:
  it used to write ONE static slot file overwritten monthly, which forced the exporter
  to sync only the latest month and close out older never-synced rows with a deliberate
  `success` row (`note: content unrecoverable`, no `vaultPath`). Those legacy closed-out
  rows still exist in the ledger and must stay untouched — their markers never move, so
  they classify as unchanged forever.
- **T447 — never a vault path in `detail.markdown`/`detail.path`.** The exporter's success
  detail keeps `detail.markdown` pointing at the SOURCE repo file (which the store
  relativizes as usual, and which the dashboard Output section's View button can preview);
  the vault destination lives in `detail.vaultPath` (vault-relative), a key
  `normalizeDetailPaths` ignores.

## Limits / schedule

Daily 07:30 (`30 7 * * *`), after the nightly places (03:00) / perfumes (02:00) runs. No
`inputKeys()` → not limitable: enumeration is a DB read of other jobs' ledgers, not a live
external source, so there is no `inputKeysService` to name (T583) and a run-limit has
nothing meaningful to bound. No paid calls, no services — pure local file copies.

## Out of scope (v1, deliberate)

Deleting vault files for removed source items; syncing non-markdown artifacts
(`progress-data.json`, `workouts-history.json`); synthesizing frontmatter for the
listening/workouts digests (copies are byte-identical); Obsidian-specific features. Adding
a new source workflow = extend `SOURCE_JOBS` + a case in `vaultTargetFor` (`lib.ts`).
