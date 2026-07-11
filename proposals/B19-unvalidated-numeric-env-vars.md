# B19: Unvalidated numeric env vars — a typo silently disables a paid service's spend caps, bricks a service, or crash-loops the daemon with a NaN port

**Type**: bug (latent, systemic) · **Priority**: P2 · **Effort**: S
**Area**: services / core / config
**Affected files**: every `src/services/*.service.ts` (~30 `Number(process.env.X ?? default)` sites — e.g. `gemini.service.ts:12-13`, `google-places.service.ts:10-11`, `finnhub.service.ts:22-24`, `trading212.service.ts:24-26`), `src/config.ts` (~76, 122, 128), `src/core/plex-client.ts` (~17, 49–53), enforcement at `src/core/services.ts` (~139–176)

## Problem

The pattern `Number(process.env.X ?? default)` has three silent failure modes, all live:

1. **Typo → NaN disables a paid cap.** `PLACES_LLM_MONTHLY_CAP=2,000` → `NaN`. In `callService`
   the check is `if (monthlyCap != null) { if (m >= monthlyCap) throw }` — `NaN != null` is
   true but `m >= NaN` is **always false** → the monthly cap on a PAID service silently stops
   existing. The rate branch (`ratePerMinute != null && ratePerMinute > 0`) also skips on NaN and
   falls through to the **unlimited** no-rate-limit branch.
2. **Set-but-empty → 0 bricks the service.** `PLACES_LLM_DAILY_CAP=` → `??` doesn't catch `''` →
   `Number('')` = 0 → `d >= 0` always true → `QuotaExceededError` on every call, with a
   confusing "quota exhausted (0/0)".
3. **Config/core sites fail differently**: `apiPort: Number(process.env.LOCALJOBS_PORT ?? 4789)`
   → NaN → `server.listen(NaN)` throws → crash-loop under launchd. The ntfy backoff numbers fail
   *silently*: `Math.min(NaN, cap)` → `NaN` → `ntfyBackoffUntil = Date.now() + NaN` → the 429
   backoff never engages, defeating that protection. Same pattern on the Plex probe/scan
   tunables.

Nothing warns at load or run time in any of these cases.

## Proposed fix

One helper, two policies:

```ts
// src/services/lib.ts (used by services) + reuse from config.ts / plex-client.ts
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) { /* policy below */ }
  return Math.trunc(n);
}
```

- **Services**: throw at registry load on non-finite/negative (fail-loud, mirroring the
  orphan-job convention — a mis-set spend cap should stop the daemon, not silently uncap it).
  This slots directly into the `defineService` refactor (R04), which applies it to all 16 files
  at once.
- **config.ts / plex-client / notifier**: warn + fallback (the daemon should still boot with a
  bad `LOCALJOBS_NTFY_BACKOFF_BASE_MS`).

## Acceptance criteria

- `PLACES_LLM_MONTHLY_CAP=2,000` → daemon refuses to start with a message naming the var.
- `PLACES_LLM_DAILY_CAP=` (empty) → default applies; no 0-cap brick.
- `LOCALJOBS_PORT=abc` → warn + default port, daemon boots.

## Test plan

Unit-test `envInt` (both policies); one registry-load test with a poisoned env var; keep
`caps.test.ts` green.
