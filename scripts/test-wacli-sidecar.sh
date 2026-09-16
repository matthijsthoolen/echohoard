#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
dockerfile="$root/container/wacli/Dockerfile"
entrypoint="$root/container/wacli/entrypoint.sh"
compose_file="$root/docker-compose.wacli.yml"

fail() { printf 'wacli sidecar contract failed: %s\n' "$1" >&2; exit 1; }

grep -F 'WACLI_SHA256=d33e8cc4b01acbd4e1ba212e22ac9c6438221e0761112dd3e7a2cc30b3a5946f' "$dockerfile" >/dev/null || fail 'upstream hash is not pinned'
grep -F 'sha256sum -c' "$dockerfile" >/dev/null || fail 'build does not verify the archive hash'
grep -F 'USER ${SIDECAR_UID}:${SIDECAR_GID}' "$dockerfile" >/dev/null || fail 'image has no non-root default user'
grep -F 'WACLI_WEBHOOK_SECRET_FILE' "$entrypoint" >/dev/null || fail 'webhook secret file is missing'
grep -E 'WACLI_WEBHOOK_SECRET=' "$entrypoint" >/dev/null && fail 'secret must not be accepted from an environment value'
grep -F -- '--webhook-secret "$secret"' "$entrypoint" >/dev/null || fail 'secret file is not passed to the fixed upstream operation'

for operation in pair follow-sync health; do
  grep -F "${operation})" "$entrypoint" >/dev/null || fail "operation ${operation} is missing"
done
grep -F 'exec /usr/local/bin/wacli "$@"' "$entrypoint" >/dev/null && fail 'launcher exposes a generic argv escape hatch'
grep -F 'exec /bin/sh' "$entrypoint" >/dev/null && fail 'launcher exposes a shell operation'
grep -F 'case "$1" in' "$entrypoint" >/dev/null || fail 'launcher has no fixed command dispatch'
sh -n "$entrypoint"

grep -F 'wacli-account-a:/var/lib/wacli/account' "$compose_file" >/dev/null || fail 'named account store is missing'
grep -F 'read_only: true' "$compose_file" >/dev/null || fail 'sidecars are not read-only by default'
grep -F 'restart: unless-stopped' "$compose_file" >/dev/null || fail 'follow-sync restart policy is missing'
grep -F 'healthcheck:' "$compose_file" >/dev/null || fail 'follow-sync healthcheck is missing'
grep -F 'ports:' "$compose_file" >/dev/null && fail 'sidecar must not publish a port'
grep -F 'cap_drop: [ALL]' "$compose_file" >/dev/null || fail 'capability bounding is missing'

if command -v docker >/dev/null 2>&1; then
  docker compose -f "$compose_file" config --quiet
else
  printf 'Docker unavailable; static sidecar contract checks passed\n'
  exit 0
fi
printf 'wacli sidecar static and Compose contract checks passed\n'
