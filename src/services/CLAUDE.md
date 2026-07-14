# CLAUDE.md — src/services/

## Authoring a service — use `defineService()`, not a hand-rolled object (T569)

Every `*.service.ts` in this directory builds its exported `ServiceDefinition` via
`defineService()` from `./lib.ts` — a **declarative** ~10-line block instead of a
hand-rolled object literal with inline `Number(process.env.X ?? default)` reads.
`defineService()` is the required authoring path for any NEW service too. Why:

- **Every numeric env read goes through `envInt()` (fail-loud), never a bare
  `Number(process.env.X ?? default)`.** The historical bug: `Number('2,000')` is
  silently `NaN`, which then flows into rate/quota math as a silent no-op limit —
  a poisoned `.env` value could quietly disable a spend cap. `defineService()`
  makes this structurally impossible: every numeric field resolves through
  `envInt(varName, fallback)`, which throws immediately at module-load time,
  naming the bad var, on an empty string, a non-numeric value, or a negative
  number.
- **`rateLimitSource` is a required field** (a TypeScript compile error to omit
  it) — a service can never silently ship without documenting where its
  rate/quota numbers came from (a vendor's published docs vs. our own
  conservative estimate vs. an empirically-tuned guess — see any service file for
  the worked convention).
- **Env var naming — `envPrefix` vs. bespoke `{ env, fallback }`.** Most fields
  just need `envPrefix: 'FOO'` and `{ fallback: N }`, which derives the
  conventional name (`FOO_RATE_PER_MIN`, `FOO_DAILY_CAP`, `FOO_MONTHLY_CAP`,
  `FOO_MIN_INTERVAL_MS`, `FOO_MAX_JITTER_MS`, `FOO_TIMEOUT_MS`,
  `FOO_CACHE_TTL_MS`). A service that predates this convention and keeps a
  pre-existing bespoke env var name (e.g. gemini's `PLACES_LLM_MONTHLY_CAP`,
  fragrantica's `PERFUMES_FETCH_DELAY_MS`) uses `{ env: 'EXACT_NAME', fallback }`
  on that one field instead — see `gemini.service.ts` / `fragrantica.service.ts`
  for the worked examples. A field with no env override at all (rare — e.g.
  `plex.service.ts`'s `timeoutMs: 300_000`) can just be a plain resolved number.
- **`dailyCap: 'monthly/30'`** (as the bare field or a `{ fallback: 'monthly/30' }`)
  resolves to `dailyFromMonthly(resolvedMonthlyCap)` — the standard sentinel for a
  PAID, daily-scheduled service (see `gemini.service.ts` / `google-places.service.ts`
  / `dynamodb.service.ts`); `caps.test.ts` is the regression guard that this
  invariant holds.
- A service with **no meaningful rate/quota to model** (a local resource the
  owner controls — `fs.service.ts`, `plex.service.ts`) simply omits the numeric
  fields; `defineService()` leaves them `undefined`, and `callService`'s existing
  "no limit configured" branch falls through to pure call-count metering.

`src/services/lib.test.ts` is `defineService()`'s own unit suite (env-prefix
resolution, bespoke `{ env }` overrides, the `monthly/30` sentinel, the required
`rateLimitSource` compile-error). `src/services/effective-limits-snapshot.test.ts`
pins every service's EFFECTIVE limits to a frozen snapshot plus a poisoned-env
regression case — update the snapshot in the SAME change as any deliberate limit
change, never as an unexamined side-effect of refactoring.

## Client-helper convention: split-file is the go-forward standard for NEW services (T569)

A service file may need real client logic beyond the declarative `ServiceDefinition`
— a lazy-initialised SDK client, fetch/normalize helpers, injectable fetchers for
tests. **For any NEW service, put that client logic in a SIBLING file** (e.g.
`foo-client.ts` next to `foo.service.ts`), keeping `foo.service.ts` itself down to
the doc comment + the `defineService()` call + its export. This keeps the
registry's auto-discovery scan (`*.service.ts`) honest — a service file stays a
small, readable declaration of WHAT is rate/quota-governed, not a mix of that and
HOW the client works.

**The three existing services with client logic colocated in the `*.service.ts`
file itself — `trading212.service.ts` (~230 lines), `dynamodb.service.ts` (~180),
`openfigi.service.ts` (~80) — are deliberately NOT being split.** This was an
explicit owner decision (2026-07-12): only their `ServiceDefinition` object was
migrated onto `defineService()`; the fetch/normalize/client-init functions stay
exactly where they are. Do not refactor these three into split files as a
"cleanup" — that would be an unreviewed, out-of-scope change to files the owner
chose to leave alone. The split-file convention above applies going forward, to
services added from here on.

## 🚫 Broker / trading-account services are READ-ONLY, always (non-negotiable)

Any service defined in this directory that talks to a stock/investment broker or
trading-account API — starting with `trading212.service.ts`
(https://docs.trading212.com/api) — must be **strictly read-only**. This applies
to every broker integration added here, present or future, not just Trading212:

- **No mutating request of any kind.** No `POST`, `PUT`, `PATCH`, or `DELETE` call
  to a broker API. Only `GET`/read endpoints (portfolio holdings, prices, account
  value, order history as data) are permitted.
- **No account mutation.** No placing, cancelling, or modifying an order; no
  transfers; no account changes — nothing that could move money or change state on
  the broker side.
- If a task or job would require a mutating call to accomplish its goal, that's a
  sign the task is out of scope — stop and flag it rather than making the call.

This is a local reinforcement of the identical rule in the root `CLAUDE.md`
("Broker / trading APIs are READ-ONLY, always"). It's repeated here because Claude
Code loads the nearest `CLAUDE.md` when working directly inside `src/services/`, so
the rule surfaces automatically to any future session or agent touching a service
file in this directory — not just one that happened to read the root doc first.

For the Trading212 integration specifically, the canonical API reference is
https://docs.trading212.com/api.

## 🚫 DynamoDB write functions are disabled by default

`dynamoPut`, `dynamoDelete`, and `dynamoBatchWrite` in `dynamodb.service.ts` are
intentionally neutered — each throws an explicit "disabled" error immediately on
call, for every input, and never reaches the AWS SDK. Only the read helpers
(`dynamoGet`, `dynamoQuery`, `dynamoScan`) are live. This mirrors the broker
read-only rule above, scoped to these three named functions rather than a whole
external integration: nothing in this repo currently calls them, and re-enabling
any of them requires the owner to deliberately restore the real function body as
a reviewed change — not something a future job can silently opt back into.
