# ADR-0001: Pull-request quality gates

- Status: accepted
- Date: 2026-09-10

## Decision

Every pull request runs the repository's pinned dependency installation and
the eight quality commands below in `.github/workflows/ci.yml`:

1. `pnpm format`
2. `pnpm lint`
3. `pnpm typecheck`
4. `pnpm architecture`
5. `pnpm test:unit`
6. `pnpm test:functional`
7. `pnpm test:browser`
8. `pnpm build`

Installation is `pnpm install --frozen-lockfile`. The workflow uses the Node
version in `.nvmrc`, pnpm `9.15.5`, and GitHub-hosted Ubuntu runners. The
functional smoke owns its disposable PostgreSQL container and synthetic test
credentials; no repository or workflow secret is required.

## Rationale

Keeping the workflow as explicit commands makes local reproduction exact and
keeps architecture, coverage, database, browser, and production-build seams
visible in review. Coverage thresholds remain in `vitest.config.ts`, where the
unit command enforces them.
