# Container-level synthetic acceptance

`pnpm test:container-acceptance` runs the EH-10-05 seam twice. Each iteration
starts a fresh disposable PostgreSQL 16 container and runs the complete
synthetic functional suite inside the Dockerfile build stage. That suite
covers import lifecycle and duplicate convergence, rich media and safe media
delivery, conversation browsing, search, health/statistics, and the private
MCP tools through the application seam. The harness also seeds a disposable
archive, posts a correctly account-bound signed webhook to the packaged HTTP
endpoint, waits for the packaged worker to normalize and persist it, and then
calls the packaged MCP endpoint over HTTP. Those calls cover discovery, all
seven bounded reads, authentication, archive isolation, and MCP privacy
denial.

The same packaged image is then started as the web and worker roles. The
harness probes web liveness (`/health`) and migration readiness (`/ready`),
delivers only the example worker secret, posts the synthetic webhook, verifies
the normalized message and missing-media state over packaged MCP, sends
`SIGKILL` to the worker, and checks that a restarted worker writes a fresh
`ready` status. The synthetic intake tests provide the durable lease/recovery
and no-duplicate assertions.

Only synthetic values are used. The report is written to
`.tmp/eh-10-05/acceptance.json` (or `ECHOHOARD_ACCEPTANCE_REPORT_DIR`) and
contains image tags and check names, never database URLs, credentials, source
paths, message bodies, or private deployment details. The disposable database,
containers, and volumes are removed on exit.

## Run

```sh
pnpm test:container-acceptance
```

The harness returns `2` with a `BLOCKED_ENV:` message when Docker or its daemon
is unavailable. A failed HTTP, migration, functional, or worker probe returns a
non-zero failure and preserves the exact failing command output. A successful
run writes the sanitized report only after both clean-volume iterations pass.

The runtime image and the build-stage test image can be overridden for CI:

```sh
ECHOHOARD_ACCEPTANCE_IMAGE=registry.example/echohoard@sha256:... \
ECHOHOARD_ACCEPTANCE_TEST_IMAGE=echohoard:tests \
pnpm test:container-acceptance
```
