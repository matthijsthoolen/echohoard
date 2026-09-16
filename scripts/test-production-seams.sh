#!/usr/bin/env bash
set -Eeuo pipefail

mode="${1:-full}"
[[ "${2:-}" == "--dry-run" ]] && mode="--dry-run"
report_dir="${ECHOHOARD_SEAMS_REPORT_DIR:-.tmp/production-seams}"
report_file="$report_dir/result.json"
image="${ECHOHOARD_SEAMS_IMAGE:-echohoard:ehv2-10-05-acceptance}"
# test:mcp-transport is invoked by test:container-acceptance against the
# packaged web role, so the transport is covered by this same aggregate.

gates=(
  "functional:pnpm test:functional"
  "entrypoint:pnpm test:entrypoint"
  "sidecar:pnpm test:wacli-sidecar"
  "container: ECHOHOARD_IMAGE=$image pnpm test:container"
  "compose:ECHOHOARD_IMAGE=$image pnpm test:compose-lifecycle"
  "acceptance:ECHOHOARD_ACCEPTANCE_IMAGE=$image pnpm test:container-acceptance"
  "viewer:pnpm test:viewer"
)

if [[ "$mode" == "--dry-run" || "$mode" == "dry-run" ]]; then
  printf 'Production seam aggregate (dry run; no Docker, endpoints, secrets, or archive data)\n'
  printf 'Estimated local durations (cold cache):\n'
  printf '  functional  30-90s   entrypoint  <5s   sidecar  <5s\n'
  printf '  container    2-5m    compose     15-45s acceptance 3-8m\n'
  printf '  viewer       30-90s   total       7-15m\n'
  printf 'Required gates:\n'
  printf '  - PostgreSQL functional tests with migrations\n'
  printf '  - secret-file entrypoint negative/positive checks\n'
  printf '  - pinned WhatsApp sidecar contract\n'
  printf '  - non-root container build and role smoke\n'
  printf '  - Compose lifecycle/readiness checks\n'
  printf '  - two-iteration synthetic container acceptance\n'
  printf '  - viewer accessibility and anonymous/auth boundary\n'
  printf '  - packaged MCP transport denial/auth/session/allowlist (inside acceptance)\n'
  exit 0
fi

[[ "$mode" == "full" ]] || { echo "Usage: $0 [--dry-run|full]" >&2; exit 2; }
command -v docker >/dev/null 2>&1 || { echo "Docker CLI is required" >&2; exit 2; }
docker info >/dev/null 2>&1 || { echo "Docker daemon is unavailable" >&2; exit 2; }
mkdir -p "$report_dir"
rm -f "$report_file"

started=$(date +%s)
results=()
for gate in "${gates[@]}"; do
  name=${gate%%:*}
  command=${gate#*:}
  gate_started=$(date +%s)
  echo "==> $name"
  if env ECHOHOARD_IMAGE="$image" ECHOHOARD_ACCEPTANCE_IMAGE="$image" bash -c "$command"; then
    status=passed
  else
    status=failed
  fi
  duration=$(( $(date +%s) - gate_started ))
  results+=("{\"name\":\"$name\",\"status\":\"$status\",\"durationSeconds\":$duration}")
  [[ "$status" == passed ]] || {
    printf '{"result":"failed","durationSeconds":%s,"gates":[%s]}\n' "$(( $(date +%s) - started ))" "$(IFS=,; echo "${results[*]}")" > "$report_file"
    exit 1
  }
done

printf '{"result":"passed","durationSeconds":%s,"gates":[%s]}\n' "$(( $(date +%s) - started ))" "$(IFS=,; echo "${results[*]}")" > "$report_file"
echo "Production seam aggregate passed; sanitized evidence: $report_file"
