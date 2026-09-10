# PostgreSQL functional tests

The functional suite uses the same Prisma migration command as production:
`prisma migrate deploy`. It starts a disposable PostgreSQL 16 container with
`docker compose`, applies the committed migrations to a fresh database, runs
the synthetic smoke test, and removes the container and volumes on exit.

Run it with:

```sh
pnpm test:functional
```

The suite includes the synthetic intake lifecycle: stable inbox claim, immutable
snapshot publication, secret-safe subprocess decryption, duplicate convergence,
retry/stale-lease recovery, SQLite validation, and plaintext cleanup. Run it
twice from a clean checkout to verify repeatability:

```sh
pnpm test:functional && pnpm test:functional
```

The test database is bound only to `127.0.0.1:55432`, uses synthetic
credentials, and is never persisted. Run the command repeatedly; each run
creates and destroys its own database state.
