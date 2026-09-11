#!/bin/sh
set -eu

case "${ECHOHOARD_ROLE:-web}" in
  web)
    exec node /app/node_modules/next/dist/bin/next start /app/src/delivery/web \
      --hostname "${ECHOHOARD_HOST:-0.0.0.0}" \
      --port "${PORT:-3000}"
    ;;
  worker)
    # Keep the decryption dependency worker-local and prove it is importable
    # before starting the worker composition root. No key or archive data is
    # read during this preflight.
    python -c 'import wa_crypt_tools; print("EchoHoard decryption adapter ready")'
    exec node /app/dist/worker/index.js
    ;;
  migrate)
    : "${ECHOHOARD_DATABASE_URL_FILE:?ECHOHOARD_DATABASE_URL_FILE is required for migrations}"
    if [ ! -r "${ECHOHOARD_DATABASE_URL_FILE}" ]; then
      echo "database URL secret file is not readable" >&2
      exit 78
    fi
    # The URL is deliberately read only into this process environment. Prisma
    # receives it through its standard contract; it is never printed or saved.
    DATABASE_URL="$(cat "${ECHOHOARD_DATABASE_URL_FILE}")"
    export DATABASE_URL
    exec node /app/node_modules/prisma/build/index.js migrate deploy
    ;;
  *)
    echo "ECHOHOARD_ROLE must be web, worker, or migrate" >&2
    exit 64
    ;;
esac
