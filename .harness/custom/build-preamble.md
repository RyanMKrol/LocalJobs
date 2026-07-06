NEVER make live PAID-API calls (Google Places, Gemini) during a build or its verification — that
spends the monthly cap. Use EXISTING fetched data under each job's data/ folder, or synthetic
fixtures, plus the scratch DB. If a check genuinely requires a paid call, do NOT make it: stop and
record `failed:blocked <TASK> needs a live <api> call` for a human.

Broker / trading APIs (e.g. Trading212) are strictly READ-ONLY — never issue a mutating request
(no placing/cancelling orders, transfers, or account changes); only GET/read endpoints are permitted.
