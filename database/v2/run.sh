#!/bin/sh
# run.sh — the migrator-v2 entrypoint: creates the database PGDATABASE names if it is missing, then
# runs migrate.sh with the same arguments. See database/v2/README.md.
#
#   run.sh up | down <version> | status | verify
#
# Connection: the libpq variables, as for migrate.sh. PGUSER must be allowed to CREATE DATABASE.

# Stop on the first failed command and on any unset variable.
set -eu

# migrate.sh connects to PGDATABASE and never creates it. CREATE DATABASE cannot run in a
# transaction or take IF NOT EXISTS, so it is generated only when the database is missing and run
# by \gexec, from the maintenance database. A second run generates nothing. Only the commands that
# write the schema create it: status and verify report on what is there, and must not make it.
case "${1:-}" in
up | down)
    psql -X -q -v ON_ERROR_STOP=1 -v db="$PGDATABASE" -d postgres <<'SQL'
SELECT format('CREATE DATABASE %I', :'db')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'db') \gexec
SQL
    ;;
esac

exec sh "$(dirname "$0")/migrate.sh" "$@"
