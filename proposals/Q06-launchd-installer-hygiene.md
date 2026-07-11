# Q06: launchd installer hygiene — baked node path goes stale, legacy load/unload API, stale port comment

**Type**: quality (ops) · **Priority**: P3 · **Effort**: S
**Area**: scripts / ops
**Affected files**: `scripts/install-launchd.sh` (~8, 31–36, 57–59), `scripts/install-dashboard-launchd.sh` (~2–3), `scripts/start-daemon.sh`

## Problem

1. **Baked node path**: `NODE_BIN_DIR="$(dirname "$(command -v node)")"` freezes the
   nvm-versioned path (e.g. `.nvm/versions/node/v22.18.0/bin`) into the plist at install time.
   After `nvm install 24` the daemon silently keeps running the old Node; after
   `nvm uninstall` of that version the daemon **dies at next boot** with a PATH error visible
   only in `daemon.err.log` — and (until F06 lands) nothing alerts.
2. **Legacy API**: `launchctl load/unload` still works but `bootstrap`/`bootout gui/$(id -u)`
   gives real error messages; low priority modernization.
3. **Stale comment**: the dashboard installer's header says "http://localhost:3001" — the port
   is 4788 (the final echo is correct). A copy-paste fossil in a repo whose rules treat stale
   docs as bugs.

## Proposed fix

- Resolve the node bin dir at RUN time inside `start-daemon.sh` (which already owns PATH
  injection) instead of baking it into the plist — the plist then only needs the wrapper path.
  Apply the same to the dashboard agent's wrapper.
- Fix the 3001 comment; optionally move to bootstrap/bootout.
- Pair with T03's `engines`/`.nvmrc` pinning so all three environments (CI, local, launchd)
  agree on the Node major.

## Acceptance criteria

- `nvm install <new>` + `launchctl kickstart -k` picks up the new Node without re-running the
  installer; removing the old nvm version does not kill the daemon at boot.
- Installers re-run cleanly over an existing install.

## Test plan

Manual on the Mini (installer scripts have no test harness): install → verify plist contents →
switch nvm default → kickstart → `/api/health` responds.
