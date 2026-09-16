# CI and production seam evidence

Pull requests and tagged releases use the same reusable `ci.yml` quality
workflow. The `integration-seams` job is required by the aggregate `quality`
job and runs only synthetic evidence: PostgreSQL migrations and functional
tests, entrypoint secret-file checks, the pinned WhatsApp sidecar contract,
non-root image/role acceptance, Compose lifecycle checks, packaged viewer
checks, and authenticated MCP transport checks. No live endpoint, secret, or
personal archive data is used.

## Local commands

Use the dry run to inspect the complete gate list without Docker or network
activity:

```sh
pnpm test:production-seams -- --dry-run
```

Run the full local aggregate after Docker is available:

```sh
pnpm test:production-seams
```

The aggregate writes sanitized per-gate status and elapsed seconds to
`.tmp/production-seams/result.json` (ignored by Git). Expected cold-cache
durations are approximately: functional 30–90 seconds, entrypoint and
sidecar under 5 seconds each, container 2–5 minutes, Compose 15–45 seconds,
two-iteration acceptance 3–8 minutes, and viewer 30–90 seconds; total 7–15
minutes. Actual durations in the JSON report are the evidence for a run.

Unit coverage remains a fast separate job with enforced 80/80/80/70 thresholds
and an uploaded JSON summary. The production seam job does not replace it.
