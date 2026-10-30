#!/bin/sh
# roundtrip.sh — checks database/v2/migrate.sh and every V2 migration on throwaway databases (CI).
# A copy of database/tests/roundtrip.sh without its EF Core checks.
#
#   1. fresh database: up, up again (no-op), verify, tests/invariants.sql
#   2. for each applied version, newest first: down to the version below it — the schema dumps the
#      same as a fresh database built only up to that version — then up again, back to step 1's
#      schema. One version deeper per pass, so a broken down file is not hidden by an older one
#      that drops more.
#   3. an edited applied file fails verify and up; down refuses versions this copy does not contain
#      (each refusal checked by its message, not only by a non-zero exit)
#
# Connection: the libpq variables (PGHOST, PGUSER, PGPASSWORD, ...). PGDATABASE is only the
# database the scratch ones are created from; it is not touched. Needs psql, pg_dump, createdb.

# Stop on the first failed command and on any unset variable.
set -eu

# The database/v2/ folder, wherever this is run from.
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# The database scratch ones are created from, and their names (unique per run).
ADMIN=${PGDATABASE:-postgres}
DB=roundtrip_$$
REF=roundtrip_ref_$$
# Writable copies of database/v2/: a partial one per pass of step 2, an edited one for step 3.
COPY=$(mktemp -d)

# Drop the scratch databases and the copy however the script ends.
cleanup() {
    PGDATABASE=$ADMIN dropdb --if-exists "$DB"
    PGDATABASE=$ADMIN dropdb --if-exists "$REF"
    rm -rf "$COPY"
}
trap cleanup EXIT

# Print the failed check and exit 1.
fail() { echo "FAIL: $*" >&2; exit 1; }
# The runner (or the copy's runner) against database $1.
migrate() { db=$1; shift; PGDATABASE=$db sh "$ROOT/migrate.sh" "$@"; }
# The schema of database $1 without the ledgers, for comparing two databases.
dump() { pg_dump -d "$1" --schema-only --no-owner --no-privileges -T schema_migrations | grep -v '^\\\(un\)\?restrict'; }
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
psql -X -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/tests/invariants.sql"
FIRST=$(dump "$DB")

echo "== 2. down one version deeper per pass, then up"
for v in $(value "$DB" 'SELECT version FROM schema_migrations WHERE version > 0 ORDER BY 1 DESC'); do
    # The applied version just below v (numbers may have gaps).
    prev=$(value "$DB" "SELECT max(version) FROM schema_migrations WHERE version < $v")
    migrate "$DB" down "$prev"
    [ "$(value "$DB" 'SELECT max(version) FROM schema_migrations')" = "$prev" ] || fail "down $prev left newer versions"
    [ "$(dump_cols "$DB")" = "$(dump_upto "$prev")" ] || fail "down $prev left a schema other than version $prev's"
    migrate "$DB" up
    [ "$(dump "$DB")" = "$FIRST" ] || fail "up after down $prev built a different schema"
done

echo "== 3. edited files, unknown versions"
cp -R "$ROOT/." "$COPY/edited"
echo "-- edited" >> "$COPY/edited/migrations/0000_baseline.up.sql"
refuses "$COPY/edited" "$DB" "CHANGED after it was applied: 0000_baseline.up.sql" verify
refuses "$COPY/edited" "$DB" "checksum mismatch; nothing applied" up
# A version a newer release applied: down must refuse rather than skip it.
psql -X -q -d "$DB" -c "INSERT INTO schema_migrations (version, name, checksum, execution_ms) VALUES (9999, 'newer', 'x', 0)"
refuses "$ROOT" "$DB" "versions this copy does not contain (9999" down 0

echo "All round-trip checks passed."
