# Browser-test harness

`pnpm test:browser` runs a deterministic browser seam smoke test. It starts an
production web app with `next start`, requests its home page and health
endpoint, and checks stable status and content. It uses Node's built-in `fetch`
as a deterministic headless client, so a clean clone needs no browser binary.

This is a foundation seam, not a product UI test. When richer routes exist, add
focused assertions while retaining this bounded command. Do not add real
accounts, personal data, or external URLs.

Run locally with `pnpm test:browser`. The command binds only to `127.0.0.1`,
uses port `4317`, cleans up the production process, and requires neither
PostgreSQL nor Docker.
