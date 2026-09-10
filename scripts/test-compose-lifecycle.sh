#!/bin/sh
set -eu

compose="docker compose -f docker-compose.yml -p echohoard-lifecycle"
image="${ECHOHOARD_IMAGE:-echohoard:eh-10-03-smoke}"

cleanup() {
  # Volumes are disposable synthetic state; a private deployment must supply
  # its own retention policy outside this generic harness.
  $compose down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

echo "Validating generic Compose contract"
$compose config --quiet
echo "Compose syntax and placeholder secret mounts passed"

if ! docker image inspect "$image" >/dev/null 2>&1; then
  echo "Lifecycle harness blocked: image $image is not available; build it with pnpm test:container" >&2
  exit 2
fi

echo "Starting web role (database/readiness requires a supplied external PostgreSQL URL)"
ECHOHOARD_IMAGE="$image" $compose up --detach web
if ! $compose ps --status running web | grep -F web >/dev/null; then
  echo "Web role did not remain running" >&2
  exit 1
fi
echo "Web role process health passed"

echo "Worker interruption contract is lease-based: SIGTERM drains; SIGKILL is recovered by lease expiry"
echo "Lifecycle harness passed static Compose/process checks; live migration/recovery requires external PostgreSQL"
