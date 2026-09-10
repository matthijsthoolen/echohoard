#!/bin/sh
set -eu

image="${ECHOHOARD_IMAGE:-echohoard:eh-10-01-smoke}"
web_container=""
worker_container=""
sentinel_dir="$(mktemp -d)"
sentinel_secret="${sentinel_dir}/worker.key"
sentinel_value="eh-10-02-secret-sentinel"
printf '%s' "$sentinel_value" > "$sentinel_secret"
chmod 0444 "$sentinel_secret"

cleanup() {
  if [ -n "$web_container" ]; then
    docker rm --force "$web_container" >/dev/null 2>&1 || true
  fi
  if [ -n "$worker_container" ]; then
    docker rm --force "$worker_container" >/dev/null 2>&1 || true
  fi
  rm -rf "$sentinel_dir"
}
trap cleanup EXIT INT TERM

echo "Building $image"
docker build --tag "$image" .

echo "Checking worker role and worker-only decryption dependency"
worker_container="$(docker run --detach \
  --user 10002:10002 \
  --env ECHOHOARD_ROLE=worker \
  --env ECHOHOARD_WORKER_STATUS_FILE=/work/worker.status \
  "$image")"
worker_ready=false
for _attempt in $(seq 1 20); do
  worker_output="$(docker logs "$worker_container" 2>&1 || true)"
  worker_status="$(docker exec "$worker_container" sh -c \
    'cat /work/worker.status 2>/dev/null' 2>/dev/null || true)"
  if printf '%s\n' "$worker_output" | grep -F "EchoHoard decryption adapter ready" >/dev/null \
    && printf '%s\n' "$worker_output" | grep -F "EchoHoard worker ready" >/dev/null \
    && [ "$worker_status" = ready ]; then
    worker_ready=true
    break
  fi
  if [ "$(docker inspect --format '{{.State.Running}}' "$worker_container" 2>/dev/null || true)" != true ]; then
    break
  fi
  sleep 1
done
if [ "$worker_ready" != true ]; then
  echo "worker role smoke check did not reach decryption and ready state" >&2
  docker logs "$worker_container" >&2 || true
  exit 1
fi

echo "Checking non-root identities and writable path boundaries"
[ "$(docker image inspect --format '{{.Config.User}}' "$image")" = "10001:10001" ]
docker run --rm --read-only --user 10002:10002 \
  --tmpfs /data:rw,uid=10002,gid=10002,mode=700 \
  --tmpfs /work:rw,uid=10002,gid=10002,mode=700 \
  --entrypoint /bin/sh "$image" -c '
    test "$(id -u)" = 10002
    touch /data/approved /work/approved
    ! touch /app/forbidden
    ! touch /run/echohoard/forbidden
  '

echo "Checking read-only worker secret file contract"
docker run --rm --read-only --user 10002:10002 \
  --mount type=bind,source="$sentinel_secret",destination=/run/echohoard/secrets/worker.key,readonly \
  --entrypoint /bin/sh "$image" -c '
    test "$(id -u)" = 10002
    test "$(cat /run/echohoard/secrets/worker.key)" = "eh-10-02-secret-sentinel"
    ! sh -c "printf changed > /run/echohoard/secrets/worker.key"
  '

echo "Checking web cannot access worker data, work, or secrets"
docker run --rm --read-only --entrypoint /bin/sh "$image" -c '
  test "$(id -u)" = 10001
  ! test -r /data
  ! test -r /work
  ! test -r /run/echohoard/secrets
'

echo "Checking web role startup"
web_container="$(docker run --detach --read-only --tmpfs /tmp --publish 127.0.0.1::3000 --env ECHOHOARD_ROLE=web "$image")"
web_ready=false
for _attempt in $(seq 1 20); do
  if [ "$(docker inspect --format '{{.State.Running}}' "$web_container")" = "true" ]; then
    web_ready=true
    break
  fi
  sleep 1
done
[ "$web_ready" = true ]

image_metadata="$(docker history --no-trunc --format '{{.CreatedBy}}' "$image")\n$(docker image inspect "$image")"
if printf '%s' "$image_metadata" | grep -F "$sentinel_value" >/dev/null; then
  echo "sentinel secret leaked into image history or metadata" >&2
  exit 1
fi
if grep -Eiq '(onzeserver|/mnt/user|BEGIN [A-Z ]+ PRIVATE KEY)' Dockerfile container/entrypoint.sh; then
  echo "deployment-specific value found in image inputs" >&2
  exit 1
fi

echo "Container build and role-start smoke checks passed for $image"
