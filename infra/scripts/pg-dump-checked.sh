#!/usr/bin/env bash
# pg-dump-checked.sh <db> <out.sql.gz> — dumps one database of the `db` container, gzipped.
# Used for textstack_v2 (ADR-030, #1043) by backup.yml, deploy.yml and `make backup`.
#
#   exit 0  dumped to <out>, or <db> does not exist (skipped: migrator-v2 is behind a profile, so a
#           fresh server has no V2 database — a log line, not an error)
#   exit 1  the server could not be asked, or the dump is incomplete; <out> is not written
#
# Env: POSTGRES_USER (required), DB_CONTAINER (default textstack_db_prod).
set -euo pipefail

db=${1:?usage: pg-dump-checked.sh <db> <out.sql.gz>}
out=${2:?usage: pg-dump-checked.sh <db> <out.sql.gz>}
user=${POSTGRES_USER:?POSTGRES_USER is not set}
container=${DB_CONTAINER:-textstack_db_prod}

# Checked before its emptiness: a query that failed is not a database that is absent.
exists=$(docker exec "$container" psql -XtA -U "$user" -d postgres \
    -c "SELECT 1 FROM pg_database WHERE datname = '$db'") \
    || { echo "::error::cannot ask $container whether $db exists" >&2; exit 1; }
if [ -z "$exists" ]; then
    echo "No $db database on this server: dump skipped"
    exit 0
fi

# .tmp until pg_dump's last line is seen: a truncated dump never gets the real name.
trap 'rm -f "$out.tmp"' EXIT
docker exec "$container" pg_dump -U "$user" "$db" | gzip > "$out.tmp"
if ! gunzip -c < "$out.tmp" | tail -n 5 | grep -q 'PostgreSQL database dump complete'; then
    echo "::error::$db dump has no dump-complete trailer" >&2
    exit 1
fi
mv "$out.tmp" "$out"
echo "Dumped $db: $(basename "$out")"
