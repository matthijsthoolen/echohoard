#!/bin/sh
set -eu

repo_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT INT TERM

mkdir -p "$test_root/bin"
database_url='postgresql://synthetic-user:synthetic-password@database.invalid:5432/synthetic'
printf '%s' "$database_url" > "$test_root/database-url"
chmod 0400 "$test_root/database-url"

cat > "$test_root/bin/python" <<'SH'
#!/bin/sh
exit 0
SH
cat > "$test_root/bin/node" <<'SH'
#!/bin/sh
test "${DATABASE_URL:-}" = "$EXPECTED_DATABASE_URL"
printf '%s' "$ECHOHOARD_ROLE" > "$RESULT_FILE"
SH
chmod 0700 "$test_root/bin/python" "$test_root/bin/node"

for role in web worker migrate; do
  result_file="$test_root/$role.result"
  PATH="$test_root/bin:$PATH" \
    ECHOHOARD_ROLE="$role" \
    ECHOHOARD_DATABASE_URL_FILE="$test_root/database-url" \
    EXPECTED_DATABASE_URL="$database_url" \
    RESULT_FILE="$result_file" \
    sh "$repo_root/container/entrypoint.sh"
  test "$(cat "$result_file")" = "$role"
done

error_file="$test_root/missing.err"
if PATH="$test_root/bin:$PATH" \
  ECHOHOARD_ROLE=worker \
  ECHOHOARD_DATABASE_URL_FILE="$test_root/missing-database-url" \
  EXPECTED_DATABASE_URL="$database_url" \
  RESULT_FILE="$test_root/missing.result" \
  sh "$repo_root/container/entrypoint.sh" 2>"$error_file"; then
  echo "entrypoint accepted a missing database URL file" >&2
  exit 1
fi
grep -Fx 'database URL secret file is not readable' "$error_file" >/dev/null
if grep -F "$database_url" "$error_file" >/dev/null; then
  echo "database URL leaked into entrypoint diagnostics" >&2
  exit 1
fi

echo "Entrypoint secret-file checks passed"
