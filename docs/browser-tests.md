# Browser-test harness

`pnpm test:browser` runs a deterministic browser seam smoke test. It starts an
ephemeral loopback HTTP server, requests the synthetic home page and health
endpoint, and checks stable status and content. It uses only Node's built-in
HTTP server and `fetch`, so a clean clone needs no browser binary.

This is a foundation seam, not a product UI test. When real routes exist,
replace the synthetic server with a local application server (or add
Playwright as an explicitly justified dependency) while retaining this
bounded, deterministic command. Do not add real accounts, personal data, or
external URLs.

Run locally with `pnpm test:browser`. The command binds only to `127.0.0.1`,
chooses a free port, and requires neither PostgreSQL nor Docker.
