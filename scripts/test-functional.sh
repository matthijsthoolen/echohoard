#!/usr/bin/env bash
set -Eeuo pipefail

compose=(docker compose -f docker-compose.functional.yml -p echohoard-functional)
database_url="postgresql://echohoard_test:echohoard_test@127.0.0.1:55432/echohoard_functional?schema=public"

cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null
}
trap cleanup EXIT

"${compose[@]}" up --detach --wait postgres
DATABASE_URL="$database_url" pnpm exec prisma migrate deploy
DATABASE_URL="$database_url" pnpm exec prisma generate
DATABASE_URL="$database_url" pnpm exec vitest run tests/functional/postgres-smoke.test.ts
