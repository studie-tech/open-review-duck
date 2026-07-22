#!/bin/sh
set -eu

postgres_bin=""
for candidate in /usr/lib/postgresql/*/bin; do
  if [ -x "$candidate/postgres" ]; then
    postgres_bin="$candidate"
    break
  fi
done
if [ -z "$postgres_bin" ]; then
  echo "PostgreSQL server binaries are missing from the image" >&2
  exit 1
fi
postgres_data="${DATA_DIR:-/data}/postgres"
secret_directory="${DATA_DIR:-/data}/secrets"

install -d -m 0700 -o postgres -g postgres "$postgres_data"
install -d -m 0700 "$secret_directory"

if [ ! -s "$postgres_data/PG_VERSION" ]; then
  echo "Initializing ReviewDuck's local database"
  runuser -u postgres -- "$postgres_bin/initdb" \
    --auth-host=trust \
    --auth-local=trust \
    --encoding=UTF8 \
    --no-locale \
    -D "$postgres_data" >/dev/null
fi

encryption_key_file="$secret_directory/encryption-key"
internal_secret_file="$secret_directory/internal-secret"
if [ ! -s "$encryption_key_file" ]; then
  node -e 'process.stdout.write(require("node:crypto").randomBytes(48).toString("base64url"))' > "$encryption_key_file"
fi
if [ ! -s "$internal_secret_file" ]; then
  node -e 'process.stdout.write(require("node:crypto").randomBytes(48).toString("base64url"))' > "$internal_secret_file"
fi
chmod 0600 "$encryption_key_file" "$internal_secret_file"
export ENCRYPTION_KEY="$(cat "$encryption_key_file")"
export FLUE_INTERNAL_SECRET="$(cat "$internal_secret_file")"

runuser -u postgres -- "$postgres_bin/pg_ctl" \
  -D "$postgres_data" \
  -o "-c listen_addresses=127.0.0.1 -c port=5432" \
  -w start >/dev/null

shutdown() {
  [ -z "${web_pid:-}" ] || kill "$web_pid" 2>/dev/null || true
  [ -z "${agent_pid:-}" ] || kill "$agent_pid" 2>/dev/null || true
  [ -z "${maintenance_pid:-}" ] || kill "$maintenance_pid" 2>/dev/null || true
  [ -z "${web_pid:-}" ] || wait "$web_pid" 2>/dev/null || true
  [ -z "${agent_pid:-}" ] || wait "$agent_pid" 2>/dev/null || true
  [ -z "${maintenance_pid:-}" ] || wait "$maintenance_pid" 2>/dev/null || true
  runuser -u postgres -- "$postgres_bin/pg_ctl" -D "$postgres_data" -m fast -w stop >/dev/null 2>&1 || true
}

graceful_shutdown() {
  trap - INT TERM EXIT
  echo "Stopping ReviewDuck"
  shutdown
  exit 0
}

maintenance_loop() {
  while sleep 3600; do
    printf 'header = "Authorization: Bearer %s"\n' "$FLUE_INTERNAL_SECRET" |
      curl --config - --fail --silent --show-error \
        --request POST "http://127.0.0.1:${PORT:-3666}/api/internal/maintenance" \
        >/dev/null || true
  done
}

trap graceful_shutdown INT TERM
trap shutdown EXIT

if ! runuser -u postgres -- "$postgres_bin/psql" -h 127.0.0.1 -d postgres -tAc \
  "select 1 from pg_database where datname = 'reviewduck'" | grep -q 1; then
  runuser -u postgres -- "$postgres_bin/createdb" -h 127.0.0.1 reviewduck
fi

echo "Applying ReviewDuck database migrations"
runuser -u reviewduck --preserve-environment -- node ./scripts/migrate.mjs

echo "Starting ReviewDuck at http://localhost:${PORT:-3666}"
runuser -u reviewduck --preserve-environment -- \
  env PORT="${AGENT_PORT:-3100}" node ./dist/flue/server.mjs &
agent_pid=$!
runuser -u reviewduck --preserve-environment -- \
  ./node_modules/.bin/next start --hostname 0.0.0.0 --port "${PORT:-3666}" &
web_pid=$!
maintenance_loop &
maintenance_pid=$!

while kill -0 "$web_pid" 2>/dev/null && kill -0 "$agent_pid" 2>/dev/null; do
  sleep 1
done

echo "A ReviewDuck service stopped unexpectedly" >&2
exit 1
