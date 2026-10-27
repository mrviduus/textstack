#!/bin/sh
# roundtrip.sh — checks database/migrate.sh and every migration on throwaway databases (CI).
#
#   1. fresh database: up, up again (no-op), verify
#   2. for each applied version, newest first: down to the version below it — the schema dumps the
#      same as a fresh database built only up to that version — then up again, back to step 1's
#      schema. One version deeper per pass, so a broken down file is not hidden by an older one
#      that drops more.
#   3. a database EF Core built (its ledger from 0001's down file): refused while its history does
#      not end at the baseline's last EF migration; then up records the baseline without running it
#      and applies the rest
#   4. an edited applied file fails verify and up; down refuses versions this copy does not contain
#      (each refusal checked by its message, not only by a non-zero exit)
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
REF=roundtrip_ref_$$
# Writable copies of database/: a partial one per pass of step 2, an edited one for step 4.
COPY=$(mktemp -d)

# Drop the scratch databases and the copy however the script ends.
cleanup() {
    PGDATABASE=$ADMIN dropdb --if-exists "$DB"
    PGDATABASE=$ADMIN dropdb --if-exists "$EF"
    PGDATABASE=$ADMIN dropdb --if-exists "$REF"
    rm -rf "$COPY"
}
trap cleanup EXIT

# Print the failed check and exit 1.
fail() { echo "FAIL: $*" >&2; exit 1; }
# The runner (or the copy's runner) against database $1.
migrate() { db=$1; shift; PGDATABASE=$db sh "$ROOT/migrate.sh" "$@"; }
# The schema of database $1 without the ledgers, for comparing two databases.
dump() { pg_dump -d "$1" --schema-only --no-owner --no-privileges -T schema_migrations -T '"__EFMigrationsHistory"' | grep -v '^\\\(un\)\?restrict'; }
# The same, column order ignored (each CREATE TABLE's columns sorted, trailing commas cut). Only for
# down vs a fresh build: a down file that re-adds a dropped column puts it last. Every other check
# stays strict.
dump_cols() {
    dump "$1" | awk 'inb && /^\)/ { close("sort"); inb = 0 }
                     inb { sub(/,$/, ""); print | "sort"; next }
                     { print }
                     /^CREATE (UNLOGGED )?TABLE .*\($/ { fflush(); inb = 1 }'
}
# Run the runner and fail unless its output contains $2. Captured first: `| grep -q` would stop
# reading at the match and kill the runner mid-run.
expect() { out=$(migrate "$1" up); echo "$out"; case $out in *"$2"*) ;; *) fail "$3" ;; esac; }
# Fail unless the runner in folder $1, against database $2 with the remaining arguments, exits
# non-zero with $3 in its output: a refusal for any other reason proves nothing.
refuses() {
    dir=$1 db=$2 msg=$3; shift 3
    if out=$(PGDATABASE=$db sh "$dir/migrate.sh" "$@" 2>&1); then fail "migrate.sh $* succeeded; expected: $msg"; fi
    echo "$out"
    case $out in *"$msg"*) ;; *) fail "migrate.sh $* failed, but not with: $msg" ;; esac
}
# One value from database $1.
value() { psql -X -At -d "$1" -c "$2"; }
# The schema of a fresh database built from only the migrations up to version $1.
dump_upto() {
    rm -rf "$COPY/upto"; mkdir -p "$COPY/upto/migrations"; cp "$ROOT/migrate.sh" "$COPY/upto/"
    for f in "$ROOT"/migrations/*.sql; do
        [ "$(basename "$f" | cut -d_ -f1 | sed 's/^0*//; s/^$/0/')" -le "$1" ] && cp "$f" "$COPY/upto/migrations/"
    done
    PGDATABASE=$ADMIN dropdb --if-exists "$REF"; PGDATABASE=$ADMIN createdb "$REF"
    PGDATABASE=$REF sh "$COPY/upto/migrate.sh" up > /dev/null
    dump_cols "$REF"
}

echo "== 1. fresh database: up, up again, verify"
PGDATABASE=$ADMIN createdb "$DB"
migrate "$DB" up
expect "$DB" "Up to date." "a second up applied something"
migrate "$DB" verify
FIRST=$(dump "$DB")
# 0001 drops EF Core's ledger; dump() leaves that table out, so check it here.
[ "$(value "$DB" "SELECT to_regclass('public.\"__EFMigrationsHistory\"') IS NULL")" = t ] || fail "__EFMigrationsHistory survived up"

echo "== 2. down one version deeper per pass, then up"
for v in $(value "$DB" 'SELECT version FROM schema_migrations WHERE version > 0 ORDER BY 1 DESC'); do
    # The applied version just below v (numbers may have gaps).
    prev=$(value "$DB" "SELECT max(version) FROM schema_migrations WHERE version < $v")
    migrate "$DB" down "$prev"
    [ "$(value "$DB" 'SELECT max(version) FROM schema_migrations')" = "$prev" ] || fail "down $prev left newer versions"
    [ "$(dump_cols "$DB")" = "$(dump_upto "$prev")" ] || fail "down $prev left a schema other than version $prev's"
    # Below 0001, its down file must have put EF Core's ledger back, all of it.
    if [ "$prev" -lt 1 ]; then
        [ "$(value "$DB" 'SELECT count(*) || max(migration_id) FROM "__EFMigrationsHistory"')" = "147$(sed -n 's/^EF_HEAD=//p' "$ROOT/migrate.sh")" ] \
            || fail "0001 down did not restore the 147 EF history rows"
    fi
    migrate "$DB" up
    [ "$(dump "$DB")" = "$FIRST" ] || fail "up after down $prev built a different schema"
done

echo "== 3. a database EF Core built"
PGDATABASE=$ADMIN createdb "$EF"
# The baseline's schema without the runner, as the 147 EF Core migrations left production.
psql -X -q -v ON_ERROR_STOP=1 -d "$EF" -f "$ROOT/migrations/0000_baseline.up.sql"
# EF Core's ledger as production had it: 0001's down file holds its exact shape and rows.
psql -X -q -v ON_ERROR_STOP=1 -d "$EF" -f "$ROOT/migrations/0001_drop_ef_migrations_history.down.sql"
# A history past the baseline's last EF migration is another schema: refused.
psql -X -q -v ON_ERROR_STOP=1 -d "$EF" -c "INSERT INTO \"__EFMigrationsHistory\" VALUES ('20991231000000_Newer', '10.0.8')"
refuses "$ROOT" "$EF" "EF Core history ends at" up
psql -X -q -v ON_ERROR_STOP=1 -d "$EF" -c "DELETE FROM \"__EFMigrationsHistory\" WHERE migration_id = '20991231000000_Newer'"
expect "$EF" "Bootstrap:" "up did not bootstrap from the EF history"
[ "$(value "$EF" 'SELECT execution_ms FROM schema_migrations WHERE version = 0')" = 0 ] || fail "the baseline ran on an EF database"
[ "$(dump "$EF")" = "$FIRST" ] || fail "the EF database did not end at the same schema"

echo "== 4. edited files, unknown versions"
cp -R "$ROOT/." "$COPY/edited"
echo "-- edited" >> "$COPY/edited/migrations/0000_baseline.up.sql"
refuses "$COPY/edited" "$DB" "CHANGED after it was applied: 0000_baseline.up.sql" verify
refuses "$COPY/edited" "$DB" "checksum mismatch; nothing applied" up
# A version a newer release applied: down must refuse rather than skip it.
psql -X -q -d "$DB" -c "INSERT INTO schema_migrations (version, name, checksum, execution_ms) VALUES (9999, 'newer', 'x', 0)"
refuses "$ROOT" "$DB" "versions this copy does not contain (9999" down 0

echo "All round-trip checks passed."
