# Contributing

EchoHoard is public application code; do not add personal archive data,
credentials, keys, tokens, or host-specific filesystem paths. Use synthetic
fixtures only. Read `AGENTS.md` and the owning leaf-story contract before
making a change.

## Local quality gates

From the repository root, install the pinned toolchain and dependencies:

```sh
pnpm install --frozen-lockfile
```

Run the same gates used for pull requests:

```sh
pnpm format
pnpm lint
pnpm typecheck
pnpm architecture
pnpm test:unit
pnpm test:functional
pnpm test:browser
pnpm build
```

`pnpm test:functional` requires Docker and starts a disposable PostgreSQL 16
container with synthetic credentials. `pnpm test:browser` starts the built web
app on loopback and uses Node's built-in fetch; it needs no browser binary.

The unit command enforces the repository coverage floor: 80% statements,
lines, and functions, and 70% branches. `pnpm architecture:fixture` is an
intentional negative check and must fail because its fixture violates the
domain dependency rule; it is not part of the passing PR gate.
