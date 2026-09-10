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
  *)
    echo "ECHOHOARD_ROLE must be web or worker" >&2
    exit 64
    ;;
esac
