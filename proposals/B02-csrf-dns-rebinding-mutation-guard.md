# B02: Loopback trust = CSRF + DNS rebinding — any website in the local browser can invoke every mutation

**Type**: bug (auth gap) · **Priority**: P1 · **Effort**: S
**Area**: api
**Affected files**: `src/api/server.ts` (`authoriseMutation` ~290–313, guard application ~405–419, `readBody` ~315–324), `src/config.ts` (~84, 106)

## Problem

The mutation guard trusts any loopback connection unconditionally:

```ts
if (isLoopback(remoteAddress)) return true;
```

But the owner's *browser* runs on that same machine and executes arbitrary web content. Two
attack shapes:

1. **Simple-request CSRF.** Any web page the owner visits can run
   `fetch('http://127.0.0.1:4789/api/workflows/reset-output-all', {method:'POST', mode:'no-cors'})`.
   A "simple" request (no custom headers, simple content type) sends **without a CORS preflight**;
   the TCP connection originates from 127.0.0.1, so the guard authorizes it. CORS only prevents the
   page from *reading* the response — the mutation still executes. `Content-Type` is never checked
   and `readBody` happily parses a `text/plain` body as JSON, so bodied endpoints work too
   (`{"enabled":false}` → toggle). Damaging targets that need no/empty body:
   - `POST /api/workflows/reset-output-all` — destroys all workflow output + ledgers
   - `POST /api/workflows/run-all` — triggers paid API spend across every workflow
   - `POST /api/cache/clear`
   - `POST /api/stuck/unstick-bulk` / `ignore-bulk` — empty body resolves to scope **all** (see B05/B06)
   - `POST /api/services/:name/limits` — partial body silently removes paid-service caps (see B07)
2. **DNS rebinding upgrades to full read access.** The server never validates `Host`
   (`new URL(req.url ?? '/', 'http://localhost:…')` ignores it). An attacker domain that
   re-resolves to 127.0.0.1 gets same-origin read access to every GET endpoint plus invocable
   POSTs with visible responses.

This is a personal, Tailscale/loopback-bound tool, so the threat is "a malicious/compromised web
page in the owner's browser", not the open internet — but that's a realistic vector and the fixes
are cheap.

## Proposed fix

All cheap, no behavior change for legitimate callers (curl, the dashboard, harness scripts —
none of which send a hostile Host/Origin):

1. **Validate `Host`** against an allowlist — `127.0.0.1:4789`, `localhost:4789`, the configured
   `LOCALJOBS_HOST` value (plus the Tailscale hostname if used) — and return 403 otherwise. This
   kills DNS rebinding outright.
2. **On POST, require `Content-Type: application/json`** (a cross-origin page cannot send that
   without triggering a preflight, which the CORS allowlist will fail), **or** reject POSTs
   bearing a non-allowlisted `Origin` header. Header-less callers (curl, scripts) are unaffected.
3. Keep the existing token path (`LOCALJOBS_API_TOKEN`) as-is for non-loopback callers.

## Acceptance criteria

- A POST with `Host: evil.example` → 403.
- A POST with `Origin: https://evil.example` (or with `Content-Type: text/plain`, depending on
  chosen mechanism) → 403, while a header-less `curl -X POST` from loopback still succeeds and
  the dashboard (same-origin, sends application/json) still works.
- All existing guard tests in `src/api/server.test.ts` still pass; new tests cover the
  Host/Origin/Content-Type rejections.

## Test plan

Extend the guard section of `server.test.ts` (~lines 55–166) with the three rejection cases and
one happy path per legitimate caller shape.
