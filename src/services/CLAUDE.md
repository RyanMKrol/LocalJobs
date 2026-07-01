# CLAUDE.md — src/services/

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
