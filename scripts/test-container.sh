#!/bin/sh
set -eu

image="${ECHOHOARD_IMAGE:-echohoard:eh-10-01-smoke}"
web_container=""

cleanup() {
  if [ -n "$web_container" ]; then
    docker rm --force "$web_container" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

echo "Building $image"
docker build --tag "$image" .

echo "Checking worker role and worker-only decryption dependency"
worker_output="$(docker run --rm --env ECHOHOARD_ROLE=worker "$image")"
printf '%s\n' "$worker_output" | grep -F "EchoHoard decryption adapter ready" >/dev/null
printf '%s\n' "$worker_output" | grep -F "EchoHoard worker ready" >/dev/null

echo "Checking web role startup"
web_container="$(docker run --detach --publish 127.0.0.1::3000 --env ECHOHOARD_ROLE=web "$image")"
web_ready=false
for _attempt in $(seq 1 20); do
  if [ "$(docker inspect --format '{{.State.Running}}' "$web_container")" = "true" ]; then
    web_ready=true
    break
  fi
  sleep 1
done
[ "$web_ready" = true ]

grep -F "ECHOHOARD_ROLE" Dockerfile >/dev/null
if grep -Eiq '(password|secret|token|private|onzeserver)' Dockerfile container/entrypoint.sh; then
  echo "deployment-specific or secret-like value found in image inputs" >&2
  exit 1
fi

echo "Container build and role-start smoke checks passed for $image"
