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

EH-13's final boundary proof uses `pnpm test:eh13`. It first migrates the
database through the V1 migration set, loads a small synthetic V1-shaped
database, applies the EH-13 migrations, and checks that IDs/counts and
archive-local legacy account mappings survive. It then runs the complete
PostgreSQL functional suite twice, including account/source isolation,
observation replay, exclusion/re-enable, and source-deletion tombstones.
The command also runs the bounded generated rematerialization benchmark; it
never uses real archive content and removes the disposable database on exit.
