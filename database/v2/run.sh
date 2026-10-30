#!/bin/sh
# run.sh — the migrator-v2 entrypoint: creates the database PGDATABASE names if it is missing, then
# runs migrate.sh with the same arguments. See database/v2/README.md.
#
#   run.sh up | down <version> | status | verify
#
# Connection: the libpq variables, as for migrate.sh. PGUSER must be allowed to CREATE DATABASE,
# and the server must have the maintenance database `postgres` to run that statement from.

# Stop on the first failed command and on any unset variable.
set -eu

# migrate.sh connects to PGDATABASE and never creates it. CREATE DATABASE cannot run in a
# transaction or take IF NOT EXISTS, so it is generated only when the database is missing and run
# by \gexec, from the maintenance database. A second run generates nothing. Only the commands that
# write the schema create it: status and verify report on what is there, and must not make it.
case "${1:-}" in
up | down)
    # The check and the CREATE are two statements, so two runners can both find the database
    # missing. The loser is told it already exists — which is the state it wanted, so it goes on;
    # anything else is a real failure and stops the container before migrate.sh runs.
    if ! out=$(psql -X -q -v ON_ERROR_STOP=1 -v db="$PGDATABASE" -d postgres 2>&1 <<'SQL'
SELECT format('CREATE DATABASE %I', :'db')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'db') \gexec
SQL
    ); then
        case $out in
            *'already exists'* | *pg_database_datname_index*) ;;
            *) printf '%s\n' "$out" >&2; exit 1 ;;
        esac
    fi
    ;;
esac

exec sh "$(dirname "$0")/migrate.sh" "$@"
