#!/usr/bin/env bash
set -Eeuo pipefail

compose=(docker compose -f docker-compose.functional.yml -p echohoard-eh13)
database_url="postgresql://echohoard_test:echohoard_test@127.0.0.1:55432/echohoard_functional?schema=public"
tmp_dir="$(mktemp -d)"
cleanup() { "${compose[@]}" down --volumes --remove-orphans >/dev/null; rm -rf "$tmp_dir"; }
trap cleanup EXIT

"${compose[@]}" up --detach --wait postgres
cp -R prisma/migrations "$tmp_dir/migrations"
rm -rf "$tmp_dir/migrations/20260914000100_owned_accounts_import_scope" "$tmp_dir/migrations/20260914000200_source_unified_conversations" "$tmp_dir/migrations/20260914000300_typed_import_observations" "$tmp_dir/migrations/20260915000100_import_exclusion_materialization" "$tmp_dir/migrations/20260915000200_source_deletion_tombstones"
cp prisma/schema.prisma "$tmp_dir/schema.prisma"
# The temporary schema points Prisma at the copied V1 migration set first.
DATABASE_URL="$database_url" pnpm exec prisma migrate deploy --schema "$tmp_dir/schema.prisma"
DATABASE_URL="$database_url" pnpm exec prisma db execute --schema prisma/schema.prisma --file fixtures/eh-13-v1-shaped.sql
DATABASE_URL="$database_url" pnpm exec prisma migrate deploy
DATABASE_URL="$database_url" pnpm exec prisma generate
DATABASE_URL="$database_url" pnpm exec tsx scripts/assert-eh-13-migration.ts
DATABASE_URL="$database_url" pnpm exec vitest run --no-file-parallelism tests/functional
DATABASE_URL="$database_url" pnpm exec tsx scripts/benchmark-rematerialization.ts
DATABASE_URL="$database_url" pnpm exec vitest run --no-file-parallelism tests/functional
