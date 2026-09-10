# Generic container lifecycle

`docker-compose.yml` is a deployment-neutral reference composition. It runs
the same image as separate web and worker roles and connects to an external
PostgreSQL instance. Set `ECHOHOARD_DATABASE_URL` before starting it. The
default URL and secret files are deliberately invalid placeholders.

Apply migrations from a checkout with the same URL used by Compose:

```sh
DATABASE_URL="$ECHOHOARD_DATABASE_URL" pnpm db:migrate
```

The web role exposes:

- `/health`: process-level liveness, safe to use without authentication;
- `/ready`: database connectivity plus the migrated `User` table. It returns
  `503` until the database is configured and migrations have completed.

The worker writes `/work/worker.status`. `ready` means the composition root has
started; `draining` and `stopped` are written during signal handling. A normal
SIGTERM/SIGINT drains idempotently. A SIGKILL cannot run cleanup, so the worker
must never mark a job complete before its durable commit: its database lease
expires and the next worker calls stale-lease recovery before claiming work.
This is why the web role has no dependency on worker health and remains
available while workers stop.

Run `pnpm test:compose-lifecycle` for Compose rendering and local image process
checks. A full migration and kill/recovery run requires a reachable synthetic
external PostgreSQL database; the harness reports that missing capability as a
falsifiable blocker rather than inventing a successful acceptance result.
