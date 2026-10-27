#!/bin/sh
# roundtrip.sh — checks database/migrate.sh and every migration on throwaway databases (CI).
#
#   1. fresh database: up, up again (no-op), verify
#   2. for each version, newest first: down to the one below it, then up — the schema dumps the
#      same as after step 1 (each .down.sql undoes its .up.sql; one deeper per pass, so a broken
#      down file is not hidden by an older one that drops more)
#   3. a database EF Core built: up records the baseline without running it, then applies the rest
#   4. an edited applied file fails verify and up; down refuses versions this copy does not contain
#
# Connection: the libpq variables (PGHOST, PGUSER, PGPASSWORD, ...). PGDATABASE is only the
# database the scratch ones are created from; it is not touched. Needs psql, pg_dump, createdb.

# Stop on the first failed command and on any unset variable.
set -eu

# The database/ folder, wherever this is run from.
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# The database scratch ones are created from, and their names (unique per run).
ADMIN=${PGDATABASE:-postgres}
DB=roundtrip_$$
EF=roundtrip_ef_$$
# A writable copy of database/ for step 4, which edits files.
COPY=$(mktemp -d)

# Drop the scratch databases and the copy however the script ends.
cleanup() {
    PGDATABASE=$ADMIN dropdb --if-exists "$DB"
    PGDATABASE=$ADMIN dropdb --if-exists "$EF"
    rm -rf "$COPY"
}
trap cleanup EXIT

# Print the failed check and exit 1.
fail() { echo "FAIL: $*" >&2; exit 1; }
# The runner (or the copy's runner) against database $1.
migrate() { db=$1; shift; PGDATABASE=$db sh "$ROOT/migrate.sh" "$@"; }
# The schema of database $1 without the ledgers, for comparing two databases.
dump() { pg_dump -d "$1" --schema-only --no-owner --no-privileges -T schema_migrations -T '"__EFMigrationsHistory"' | grep -v '^\\\(un\)\?restrict'; }
# Run the runner and fail unless its output contains $2. Captured first: `| grep -q` would stop
# reading at the match and kill the runner mid-run.
expect() { out=$(migrate "$1" up); echo "$out"; case $out in *"$2"*) ;; *) fail "$3" ;; esac; }
# One value from database $1.
value() { psql -X -At -d "$1" -c "$2"; }

echo "== 1. fresh database: up, up again, verify"
PGDATABASE=$ADMIN createdb "$DB"
migrate "$DB" up
expect "$DB" "Up to date." "a second up applied something"
migrate "$DB" verify
FIRST=$(dump "$DB")

echo "== 2. down one version deeper per pass, then up"
for v in $(value "$DB" 'SELECT version FROM schema_migrations WHERE version > 0 ORDER BY 1 DESC'); do
    migrate "$DB" down $((v - 1))
    [ "$(value "$DB" 'SELECT max(version) FROM schema_migrations')" = $((v - 1)) ] || fail "down $((v - 1)) left newer versions"
    migrate "$DB" up
    [ "$(dump "$DB")" = "$FIRST" ] || fail "up after down $((v - 1)) built a different schema"
done

echo "== 3. a database EF Core built"
PGDATABASE=$ADMIN createdb "$EF"
# The baseline's schema without the runner, as the 147 EF Core migrations left production.
psql -X -q -v ON_ERROR_STOP=1 -d "$EF" -f "$ROOT/migrations/0000_baseline.up.sql"
psql -X -q -v ON_ERROR_STOP=1 -d "$EF" -c 'CREATE TABLE "__EFMigrationsHistory" (migration_id text PRIMARY KEY)'
expect "$EF" "Bootstrap:" "up did not bootstrap from the EF history"
[ "$(value "$EF" 'SELECT execution_ms FROM schema_migrations WHERE version = 0')" = 0 ] || fail "the baseline ran on an EF database"
[ "$(dump "$EF")" = "$FIRST" ] || fail "the EF database did not end at the same schema"

echo "== 4. edited files, unknown versions"
cp -R "$ROOT/." "$COPY"
echo "-- edited" >> "$COPY/migrations/0000_baseline.up.sql"
PGDATABASE=$DB sh "$COPY/migrate.sh" verify && fail "verify accepted an edited applied file"
PGDATABASE=$DB sh "$COPY/migrate.sh" up && fail "up ran with an edited applied file"
# A version a newer release applied: down must refuse rather than skip it.
psql -X -q -d "$DB" -c "INSERT INTO schema_migrations (version, name, checksum, execution_ms) VALUES (9999, 'newer', 'x', 0)"
migrate "$DB" down 0 && fail "down ran with a version this copy does not contain"

echo "All round-trip checks passed."
