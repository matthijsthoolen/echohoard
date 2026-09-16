#!/bin/sh
set -eu

load_database_url_file() {
  if [ -z "${ECHOHOARD_DATABASE_URL_FILE:-}" ]; then
    return
  fi
  if [ ! -r "${ECHOHOARD_DATABASE_URL_FILE}" ]; then
    echo "database URL secret file is not readable" >&2
    exit 78
  fi
  # Keep the value in this process environment only. Prisma receives its
  # standard DATABASE_URL contract; the value is never printed or persisted.
  DATABASE_URL="$(cat "${ECHOHOARD_DATABASE_URL_FILE}")"
  export DATABASE_URL
}

case "${ECHOHOARD_ROLE:-web}" in
  web)
    load_database_url_file
    exec node /app/node_modules/next/dist/bin/next start /app/src/delivery/web \
      --hostname "${ECHOHOARD_HOST:-0.0.0.0}" \
      --port "${PORT:-3000}"
    ;;
  worker)
    load_database_url_file
    # Keep the decryption dependency worker-local and prove it is importable
    # before starting the worker composition root. No key or archive data is
    # read during this preflight.
    python -c 'import wa_crypt_tools; print("EchoHoard decryption adapter ready")'
    exec node /app/dist/worker/index.js
    ;;
  migrate)
    load_database_url_file
    : "${DATABASE_URL:?DATABASE_URL or ECHOHOARD_DATABASE_URL_FILE is required for migrations}"
    exec node /app/node_modules/prisma/build/index.js migrate deploy
    ;;
  *)
    echo "ECHOHOARD_ROLE must be web, worker, or migrate" >&2
    exit 64
    ;;
esac
