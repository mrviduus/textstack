#!/bin/sh
# migrate.sh — applies the SQL files in migrations/ next to it with psql. See database/README.md.
# database/v2/migrate.sh is a symlink to this file: one runner, two databases (ADR-030). The EF
# bootstrap below only ever fires on the legacy database, which is the only one EF Core built.
#
#   migrate.sh up              apply every pending NNNN_<name>.up.sql, oldest first
#   migrate.sh down <version>  revert applied versions above <version>, newest first (.down.sql)
#   migrate.sh status          applied, pending and unknown versions
#   migrate.sh verify          applied files still match their recorded checksum
#
# Connection: the libpq variables PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD — environment,
# never argv, so the password is not in `ps`.

# Stop on the first failed command and on any unset variable.
set -eu

# The migration files sit next to this script, wherever it is run from.
DIR=$(cd "$(dirname "$0")/migrations" && pwd)

# psql without ~/.psqlrc (-X), quiet (-q), stopping at the first SQL error (exit 3).
q() { psql -X -q -v ON_ERROR_STOP=1 "$@"; }
# Print a message on stderr and exit 1.
die() { echo "ERROR: $*" >&2; exit 1; }
# sha256 of a file: sha256sum on Linux (the migrator image, CI), shasum on macOS.
checksum() { { sha256sum "$1" 2>/dev/null || shasum -a 256 "$1"; } | cut -d' ' -f1; }
# "0007" → 7: drop leading zeros, which $(( )) and test would read as octal.
num() { echo "$1" | sed 's/^0*//; s/^$/0/'; }
# "0007_add_x.up.sql" → 7.
version_of() { num "$(basename "$1" | cut -d_ -f1)"; }
# "0007_add_x.up.sql" → "0007_add_x", the name the ledger and the logs show.
label_of() { basename "$1" .up.sql; }
# A list on one line, for messages.
words() { printf '%s' "$1" | tr '\n' ' '; }
# The .up.sql (or, with "down", .down.sql) file of a version, or nothing when it has none.
file_of() { set -- "$DIR/$(printf '%04d' "$1")"_*."${2:-up}".sql; [ -e "$1" ] && echo "$1" || true; }

# The last EF Core migration production applied; the baseline is the schema it left (bootstrap).
EF_HEAD=20261024202404_TranslateRegistryOnGpt41Mini

# Every file must be NNNN_<snake_case>.up.sql or .down.sql: versions are read from the prefix (here
# and in the Api's /health/ready), so anything else would be misread.
for f in "$DIR"/*; do
    basename "$f" | grep -Eqx '[0-9]{4}_[a-z0-9_]+\.(up|down)\.sql' || die "bad migration name: $(basename "$f") (NNNN_<snake_case>.up.sql)"
done
# Every up file this copy contains, oldest first: the zero-padded prefix sorts by version.
UPS=$(ls "$DIR"/*.up.sql)
# Their versions, one per line.
KNOWN=$(for f in $UPS; do version_of "$f"; done)
# Two files of one kind with one version: the runner would pick one of them silently.
for kind in up down; do
    DUP=$(for f in "$DIR"/*."$kind".sql; do [ -e "$f" ] && version_of "$f"; done | sort -n | uniq -d)
    [ -z "$DUP" ] || die "two .$kind.sql files share version $(words "$DUP")"
done

# "version|checksum" per ledger row, oldest first; nothing when the ledger does not exist yet.
# A psql failure stops the runner, with its own message: an unreachable database must never read
# as "nothing applied" (every caller below also stops when this one does).
ledger() {
    # to_regclass is NULL for a missing table, where a plain SELECT would fail.
    has=$(q -At -c "SELECT to_regclass('public.schema_migrations') IS NOT NULL") || die "cannot read the ledger"
    if [ "$has" = t ]; then q -At -c "SELECT version || '|' || checksum FROM public.schema_migrations ORDER BY version"; fi
}
# The versions of a ledger() list.
versions() { printf '%s\n' "$1" | cut -d'|' -f1 | grep . || true; }
# Lines of list $1 that are not lines of list $2.
minus() { for x in $1; do printf '%s\n' "$2" | grep -qx "$x" || echo "$x"; done; }
# "t" when the database was built by EF Core and has no ledger yet: up will bootstrap.
ef_only() { q -At -c "SELECT to_regclass('public.schema_migrations') IS NULL AND to_regclass('public.\"__EFMigrationsHistory\"') IS NOT NULL"; }

# Create the ledger on first use; on a database EF Core migrated, record the baseline as applied.
init() {
    # The baseline stands for exactly the EF history production has. A database stopped short of
    # it (or past it) has another schema, and recording the baseline would hide that.
    if [ "$(ef_only)" = t ]; then
        head=$(q -At -c 'SELECT max(migration_id) FROM public."__EFMigrationsHistory"')
        [ "$head" = "$EF_HEAD" ] || die "EF Core history ends at '$head', the baseline at '$EF_HEAD'; a copy of this schema cannot be bootstrapped: restore a production backup, or start from an empty database"
    fi
    # One transaction; the lock makes a second runner wait here instead of racing the CREATE.
    q --single-transaction -v sum="$(checksum "$DIR/0000_baseline.up.sql")" -f - <<'SQL'
SELECT pg_advisory_xact_lock(hashtext('schema_migrations')) AS locked \gset
SELECT to_regclass('public.schema_migrations') IS NULL AS no_ledger,
       to_regclass('public."__EFMigrationsHistory"') IS NOT NULL AS from_ef \gset
\if :no_ledger
CREATE TABLE public.schema_migrations (
    version      integer     PRIMARY KEY,           -- the NNNN of the file name
    name         text        NOT NULL,              -- the rest of the file name
    checksum     text        NOT NULL,              -- sha256 of the up file as applied
    applied_at   timestamptz NOT NULL DEFAULT now(),
    execution_ms integer     NOT NULL               -- how long the up file took
);
\if :from_ef
-- Production before this runner: 147 EF Core migrations built exactly what the baseline builds.
INSERT INTO public.schema_migrations (version, name, checksum, execution_ms)
VALUES (0, 'baseline', :'sum', 0);
\echo 'Bootstrap: EF Core history found; recorded 0000_baseline as applied without running it.'
\endif
\endif
SQL
}

# Run one file and its ledger change in one transaction. $1 = file, $2 = up | down.
run() {
    # The ledger row for an up file: version, name, checksum. A down file reuses its up file's.
    up=$(file_of "$(version_of "$1")")
    echo "$2: $(label_of "$up")"
    # ON_ERROR_STOP + --single-transaction: any error rolls back the file AND the ledger change.
    q --single-transaction -v file="$1" -v v="$(version_of "$1")" -v name="$(label_of "$up" | cut -d_ -f2-)" \
      -v sum="$(checksum "$up")" -v up="$([ "$2" = up ] && echo true || echo false)" -f - <<'SQL'
-- Serialize runners: a second one waits here, then sees this version's new state below.
SELECT pg_advisory_xact_lock(hashtext('schema_migrations')) AS locked \gset
-- Up runs only if not applied; down only if applied. Another runner may have just done it.
SELECT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = :v) <> :up AS todo \gset
\if :todo
SELECT clock_timestamp() AS t0 \gset
\i :file
\if :up
INSERT INTO public.schema_migrations (version, name, checksum, execution_ms)
VALUES (:v, :'name', :'sum', (extract(epoch FROM clock_timestamp() - :'t0'::timestamptz) * 1000)::int);
\else
DELETE FROM public.schema_migrations WHERE version = :v;
\endif
\else
\echo '  already done by another run, skipped'
\endif
SQL
}

# Applied files whose checksum differs from the ledger list $1: applied files are never edited.
# Down files are not checked: until it runs, a down file may still be fixed.
verify() {
    bad=0
    for row in $1; do
        f=$(file_of "${row%%|*}")
        # Unknown versions (no file here) are reported by status and refused by down, not here.
        if [ -n "$f" ] && [ "$(checksum "$f")" != "${row#*|}" ]; then
            echo "CHANGED after it was applied: $(basename "$f") — revert the edit and add a new migration."
            bad=1
        fi
    done
    return $bad
}

case "${1:-}" in
up)
    init
    # The ledger, read once: run() re-checks each version under the lock anyway.
    L=$(ledger) || exit 1; APPLIED=$(versions "$L")
    verify "$L" || die "checksum mismatch; nothing applied"
    # After a code rollback the database is ahead of this copy: normal, left in place.
    U=$(minus "$APPLIED" "$KNOWN")
    [ -z "$U" ] || echo "NOTE: applied versions this copy does not contain: $(words "$U"). Left in place."
    PENDING=$(minus "$KNOWN" "$APPLIED")
    [ -n "$PENDING" ] || { echo "Up to date."; exit 0; }
    for v in $PENDING; do run "$(file_of "$v")" up; done
    echo "Done."
    ;;
down)
    # The target: a non-negative integer; versions above it are reverted.
    T=${2:-}
    case "$T" in '' | *[!0-9]*) die "usage: migrate.sh down <version>" ;; esac
    T=$(num "$T")
    init
    L=$(ledger) || exit 1; APPLIED=$(versions "$L")
    verify "$L" || die "checksum mismatch; nothing reverted"
    # Only the copy that contains a migration has its down file. An older copy (after a code
    # rollback) would skip it and report success — refuse. Roll the schema back first, with the
    # image deployed now, then the code (ADR-021's order).
    U=$(minus "$APPLIED" "$KNOWN")
    [ -z "$U" ] || die "the database has versions this copy does not contain ($(words "$U")); run down with the copy that has them"
    # Applied versions above the target, newest first.
    TODO=$(for v in $APPLIED; do [ "$v" -gt "$T" ] && echo "$v"; done | sort -rn)
    [ -n "$TODO" ] || { echo "Nothing above version $T."; exit 0; }
    # Check every down file exists before reverting any, so a missing one cannot stop halfway.
    for v in $TODO; do [ -n "$(file_of "$v" down)" ] || die "version $v has no .down.sql; nothing reverted"; done
    for v in $TODO; do run "$(file_of "$v" down)" down; done
    echo "Done. Schema is at version $T."
    ;;
status)
    # The ledger as a table, then what is missing on either side. Read-only: no ledger is created.
    L=$(ledger) || exit 1; APPLIED=$(versions "$L")
    if [ -n "$APPLIED" ]; then
        q -c "SELECT version, name, applied_at, execution_ms FROM public.schema_migrations ORDER BY 1"
    elif [ "$(ef_only)" = t ]; then
        echo "No ledger; EF Core history found: up will record 0000_baseline as applied without running it."
    else
        echo "No ledger yet (or it is empty): migrate.sh up creates it."
    fi
    echo "Pending: $(words "$(minus "$KNOWN" "$APPLIED")")"
    echo "Unknown (applied, no file here): $(words "$(minus "$APPLIED" "$KNOWN")")"
    ;;
verify)
    L=$(ledger) || exit 1
    if [ -z "$L" ]; then
        echo "Nothing applied yet: no file to check."
    else
        verify "$L" && echo "Checksums match."
    fi
    ;;
*)
    die "usage: migrate.sh up | down <version> | status | verify"
    ;;
esac
