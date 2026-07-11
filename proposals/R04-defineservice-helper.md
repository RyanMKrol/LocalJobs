# R04: `defineService` helper — 16 near-identical service files; the boilerplate is where the bugs live

**Type**: refactor · **Priority**: P2 · **Effort**: M
**Area**: services
**Affected files**: all `src/services/*.service.ts`, `src/services/lib.ts`, `src/services/CLAUDE.md`

## Problem

Every service definition is the same shape: name/category/description, three
`Number(process.env.<PREFIX>_X ?? default)` lines, `paid`, `rateLimitSource`. Real variation is
tiny (two paid services derive `dailyFromMonthly`, two use `minIntervalMs`, two declare
`timeoutMs`/`cacheTtlMs`). The boilerplate is exactly where the defects live:

- the ~30 unvalidated `Number()` env reads (B19's NaN/empty-string cap bugs);
- drift: `vercel.service.ts` is the ONLY definition with no `rateLimitSource` — the field every
  other service carries (and that `fs.service.test.ts` asserts for its own service); the
  Integrations page renders an empty source for vercel;
- two competing conventions for client helpers (split-file: claude-cli.service.ts + claude.ts;
  colocated: trading212/openfigi/dynamodb embed 100+ lines of fetch/normalize logic in the
  definition file).

## Proposed fix

In `src/services/lib.ts`:

```ts
export function defineService(d: {
  name: string; category: ServiceCategory; description: string; paid: boolean;
  rateLimitSource: string;               // REQUIRED → vercel's omission becomes a type error
  envPrefix?: string;                    // 'FINNHUB' → FINNHUB_RATE_PER_MIN etc.
  ratePerMinute?: number; dailyCap?: number | 'monthly/30'; monthlyCap?: number;
  minIntervalMs?: number; maxJitterMs?: number; timeoutMs?: number; cacheTtlMs?: number;
}): ServiceDefinition {
  // envInt() (B19) on every env read — throw at load on non-finite/negative;
  // dailyFromMonthly for the 'monthly/30' sentinel.
}
```

Each `*.service.ts` shrinks to ~10 lines while staying one-file-per-service (auto-discovery and
per-service doc comments unchanged). Pick ONE client-helper convention (recommend split-file:
definition stays declarative, helpers live beside it) and record it in `src/services/CLAUDE.md`.

Explicitly bundles B19's services-side fix — implement together.

## Acceptance criteria

- All 16 services register with identical effective limits to today (snapshot-compare
  `effectiveLimits` per service before/after in a test).
- `vercel` gains a real `rateLimitSource`.
- A poisoned env var (`FOO_MONTHLY_CAP=2,000`) fails at load with a message naming the var.
- `caps.test.ts` and per-service tests green; `src/services/CLAUDE.md` updated.

## Test plan

Unit-test `defineService` (env precedence, monthly/30 sentinel, envInt policy); the
before/after limits snapshot test guards the migration.
