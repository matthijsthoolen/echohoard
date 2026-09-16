#!/bin/sh
set -eu

die() {
  printf '%s\n' "$1" >&2
  exit 64
}

[ "$#" -eq 1 ] || die "one fixed wacli operation is required"
[ "$(id -u)" -ne 0 ] || die "wacli sidecar must not run as root"

case "$1" in
  control)
    exec node /usr/local/bin/echohoard-wacli-control.mjs
    ;;
esac

[ -n "${WACLI_ACCOUNT:-}" ] || die "WACLI_ACCOUNT is required"
case "${WACLI_ACCOUNT}" in
  [a-z0-9][a-z0-9-]*) : ;;
  *) die "WACLI_ACCOUNT is not a valid named account" ;;
esac
[ "${WACLI_ACCOUNT_STORE:-}" = /var/lib/wacli/account ] || die "account store path is fixed"
export HOME=/var/lib/wacli/account
export XDG_CONFIG_HOME=/var/lib/wacli/account/config
export XDG_DATA_HOME=/var/lib/wacli/account/data
mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"

case "$1" in
  pair)
    exec /usr/local/bin/wacli --account "${WACLI_ACCOUNT}" --events auth --qr-format text
    ;;
  follow-sync)
    secret_file="${WACLI_WEBHOOK_SECRET_FILE:-/run/secrets/wacli_webhook_key}"
    [ -f "$secret_file" ] && [ -r "$secret_file" ] || die "webhook secret file is not readable"
    [ "$(wc -c < "$secret_file")" -le 256 ] || die "webhook secret is too large"
    secret="$(tr -d '\r\n' < "$secret_file")"
    [ -n "$secret" ] || die "webhook secret file is empty"
    exec /usr/local/bin/wacli --account "${WACLI_ACCOUNT}" --events sync --follow \
      --presence-mode quiet --webhook "${WACLI_WEBHOOK_ENDPOINT:-http://web:3000/api/internal/live-events?account=${WACLI_ACCOUNT}}" \
      --webhook-events message,receipt,chat_presence --webhook-secret "$secret"
    ;;
  health)
    exec /usr/local/bin/wacli --account "${WACLI_ACCOUNT}" --read-only --json auth status
    ;;
  *)
    die "operation is not allowlisted (use control, pair, follow-sync, or health)"
    ;;
esac
