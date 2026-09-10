#!/bin/sh
set -eu

: "${DATABASE_URL:?DATABASE_URL must point to an external PostgreSQL database}"
exec pnpm exec prisma migrate deploy
