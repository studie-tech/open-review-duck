#!/bin/sh
set -eu

data_directory="${LOCAL_DATA_DIR:-/data}"

if [ "${REVIEWDUCK_PRIVILEGES_DROPPED:-0}" != "1" ]; then
  install -d -m 0700 -o reviewduck -g reviewduck "$data_directory"
  export REVIEWDUCK_PRIVILEGES_DROPPED=1
  exec setpriv \
    --reuid=reviewduck \
    --regid=reviewduck \
    --init-groups \
    --no-new-privs \
    "$0" "$@"
fi

umask 077
postgres_bin="/usr/lib/postgresql/18/bin"
postgres_data="$data_directory/postgres"
socket_directory="$data_directory/run/postgresql"
secret_directory="$data_directory/secrets"
backup_directory="$data_directory/backups"

mkdir -p "$postgres_data" "$socket_directory" "$secret_directory" \
  "$backup_directory" "$data_directory/objects"
chmod 0700 "$postgres_data" "$secret_directory" "$backup_directory"
chmod 0770 "$socket_directory"

write_secret() {
  target="$1"
  if [ ! -s "$target" ]; then
    temporary="$(mktemp "$secret_directory/.secret.XXXXXX")"
    node -e 'process.stdout.write(require("node:crypto").randomBytes(48).toString("base64url"))' > "$temporary"
    chmod 0600 "$temporary"
    mv "$temporary" "$target"
  fi
}

write_secret "$secret_directory/database"
write_secret "$secret_directory/encryption"
write_secret "$secret_directory/session"
write_secret "$secret_directory/storage-id"
write_secret "$secret_directory/cron"

database_password="$(cat "$secret_directory/database")"
export ENCRYPTION_KEY="$(cat "$secret_directory/encryption")"
export LOCAL_SESSION_SECRET="$(cat "$secret_directory/session")"
export STORAGE_ID_KEY="$(cat "$secret_directory/storage-id")"
export CRON_SECRET="$(cat "$secret_directory/cron")"
export DATABASE_URL="postgresql://reviewduck:${database_password}@localhost/reviewduck?host=${socket_directory}"
export MIGRATION_DATABASE_URL="$DATABASE_URL"
export WORKFLOW_POSTGRES_URL="$DATABASE_URL"

available_kib="$(df -Pk "$data_directory" | awk 'NR == 2 { print $4 }')"
if [ "${available_kib:-0}" -lt 262144 ]; then
  echo "ReviewDuck requires at least 256 MiB of free space in $data_directory" >&2
  exit 1
fi

if [ ! -s "$postgres_data/PG_VERSION" ]; then
  echo "Initializing PostgreSQL 18"
  "$postgres_bin/initdb" \
    --username=reviewduck \
    --pwfile="$secret_directory/database" \
    --auth-local=scram-sha-256 \
    --auth-host=scram-sha-256 \
    --encoding=UTF8 \
    --no-locale \
    -D "$postgres_data" >/dev/null
fi

postgres_started=0
if "$postgres_bin/pg_ctl" -D "$postgres_data" status >/dev/null 2>&1; then
  if [ "${1:-}" != "admin" ]; then
    echo "PostgreSQL is already running for this data volume" >&2
    exit 1
  fi
else
  "$postgres_bin/pg_ctl" \
    -D "$postgres_data" \
    -o "-c listen_addresses='' -c unix_socket_directories='$socket_directory' -c unix_socket_permissions=0770" \
    -w start >/dev/null
  postgres_started=1
fi

shutdown() {
  trap - INT TERM EXIT
  if [ -n "${web_pid:-}" ] || [ "$postgres_started" = "1" ]; then
    echo "Stopping ReviewDuck"
  fi
  if [ -n "${web_pid:-}" ]; then
    kill -TERM "$web_pid" 2>/dev/null || true
    attempts=0
    while kill -0 "$web_pid" 2>/dev/null && [ "$attempts" -lt 30 ]; do
      sleep 1
      attempts=$((attempts + 1))
    done
    kill -KILL "$web_pid" 2>/dev/null || true
    wait "$web_pid" 2>/dev/null || true
  fi
  if [ -n "${maintenance_pid:-}" ]; then
    kill "$maintenance_pid" 2>/dev/null || true
    wait "$maintenance_pid" 2>/dev/null || true
  fi
  if [ "$postgres_started" = "1" ]; then
    "$postgres_bin/pg_ctl" -D "$postgres_data" -m fast -w stop >/dev/null 2>&1 || true
  fi
}
trap shutdown INT TERM EXIT

if ! PGPASSWORD="$database_password" "$postgres_bin/psql" \
  -h "$socket_directory" -U reviewduck -d postgres -tAc \
  "select 1 from pg_database where datname = 'reviewduck'" | grep -q 1; then
  PGPASSWORD="$database_password" "$postgres_bin/createdb" \
    -h "$socket_directory" -U reviewduck reviewduck
fi

if [ "${1:-}" = "admin" ]; then
  shift
  node ./scripts/local-admin.mjs "$@"
  exit 0
fi

if PGPASSWORD="$database_password" "$postgres_bin/psql" \
  -h "$socket_directory" -U reviewduck -d reviewduck -tAc \
  "select to_regclass('drizzle.__drizzle_migrations') is not null" | grep -q t; then
  installed_hash="$(PGPASSWORD="$database_password" "$postgres_bin/psql" \
    -h "$socket_directory" -U reviewduck -d reviewduck -tAc \
    'select hash from drizzle.__drizzle_migrations order by created_at desc limit 1')"
  target_hash="$(node ./scripts/latest-migration-hash.mjs)"
  if [ "$installed_hash" != "$target_hash" ]; then
    backup_path="$backup_directory/upgrade-$(date -u +%Y%m%dT%H%M%SZ).dump"
    echo "Creating verified pre-upgrade backup"
    PGPASSWORD="$database_password" "$postgres_bin/pg_dump" \
      -h "$socket_directory" -U reviewduck -d reviewduck \
      --format=custom --file="$backup_path"
    "$postgres_bin/pg_restore" --list "$backup_path" >/dev/null
    ls -1t "$backup_directory"/upgrade-*.dump 2>/dev/null |
      awk 'NR > 3' |
      while IFS= read -r expired_backup; do
        rm -f -- "$expired_backup"
      done
  fi
fi

echo "Applying ReviewDuck database migrations"
node ./scripts/migrate.mjs
node ./scripts/setup-workflow.mjs
node ./scripts/local-bootstrap.mjs

maintenance_loop() {
  attempts=0
  until curl --fail --silent "http://127.0.0.1:${PORT:-3000}/api/health" >/dev/null; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 60 ]; then
      echo "Maintenance could not confirm application health" >&2
      return
    fi
    sleep 1
  done
  while :; do
    curl --fail --silent --show-error \
      --request POST \
      --header "Authorization: Bearer $CRON_SECRET" \
      "http://127.0.0.1:${PORT:-3000}/api/internal/maintenance" >/dev/null || true
    sleep 86400
  done
}

listen_address="${HOSTNAME:-0.0.0.0}"
if [ -n "${REVIEWDUCK_LISTEN:-}" ]; then
  export HOSTNAME="$REVIEWDUCK_LISTEN"
elif [ "$listen_address" != "0.0.0.0" ] &&
  [ "$listen_address" != "::" ] &&
  [ "$listen_address" != "127.0.0.1" ] &&
  [ "$listen_address" != "localhost" ] &&
  [ "$listen_address" != "::1" ]; then
  echo "Container HOSTNAME '$listen_address' is not a bind address; listening on 0.0.0.0 inside the container." >&2
  export HOSTNAME=0.0.0.0
fi
echo "Starting ReviewDuck ${REVIEWDUCK_VERSION:-development} at http://localhost:${PORT:-3000}. Publish the port as 127.0.0.1:${PORT:-3000}:3000."
node ./server.js &
web_pid=$!
maintenance_loop &
maintenance_pid=$!
wait "$web_pid"
