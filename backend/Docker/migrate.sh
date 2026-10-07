#!/bin/sh
set -e

# Runs in the migrator image (Migrator.Dockerfile): an EF Core migrations bundle (/app/efbundle),
# the list of migrations it contains (/app/known-migrations, written at build time) and psql.
BUNDLE=/app/efbundle
KNOWN=/app/known-migrations
# Required: unset, the bundle would fall back to AppDbContextFactory's localhost default.
CONNECTION="${ConnectionStrings__Default:?ConnectionStrings__Default is not set}"
# The bundle gets it through AppDbContextFactory (CONNECTION_STRING) and psql through PG* variables:
# environment, never argv, so the password is not in `ps`.
export CONNECTION_STRING="$CONNECTION"

echo "=== EF Core Migration Runner ==="
echo "Target: ${MIGRATE_TARGET:-latest}"
echo "Image contains $(wc -l < "$KNOWN" | tr -d ' ') migrations (newest: $(tail -n 1 "$KNOWN"))."

# psql reads the same database. Never echo CONNECTION: it carries the password.
conn_field() { printf '%s' "$CONNECTION" | tr ';' '\n' | sed -n "s/^ *$1=//p" | head -n 1; }
PGHOST=$(conn_field Host); PGPORT=$(conn_field Port); PGDATABASE=$(conn_field Database)
PGUSER=$(conn_field Username); PGPASSWORD=$(conn_field Password)
export PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD

# Applied migration ids, oldest first; empty on a fresh database (no history table yet).
# A psql failure returns non-zero, and the plain assignments that call it stop the script (set -e)
# instead of reading as "nothing applied".
applied() {
    has=$(psql -XAtc "SELECT to_regclass('\"__EFMigrationsHistory\"') IS NOT NULL") || return 1
    if [ "$has" = "t" ]; then psql -XAtc 'SELECT migration_id FROM "__EFMigrationsHistory" ORDER BY 1' || return 1; fi
}
# Lines of $1 that are not lines of file $2.
minus() { printf '%s\n' "$1" | grep -vxF -f "$2" | grep . || true; }

# Step 0: migrations the DB has applied that this image does not contain (ADR-021).
# EF reverts only what its own assembly knows, so a rollback run by an OLDER image (e.g. after a code
# rollback re-tagged textstack-migrator:latest) reverts nothing and exits 0. Refuse that loudly.
# Without a target this is the normal state after a code rollback: report it, change nothing.
APPLIED=$(applied)
UNKNOWN=$(minus "$APPLIED" "$KNOWN")
if [ -n "$UNKNOWN" ]; then
    COUNT=$(printf '%s\n' "$UNKNOWN" | wc -l | tr -d ' ')
    NEWEST=$(printf '%s\n' "$UNKNOWN" | tail -n 1)
    if [ -n "$MIGRATE_TARGET" ]; then
        echo "ERROR: the database has $COUNT applied migration(s) this image does not contain (newest: $NEWEST)."
        echo "This image cannot revert them; MIGRATE_TARGET would silently do nothing."
        echo "Roll the schema back with the image that contains them (the one deployed now), then roll the code back."
        exit 1
    fi
    echo "NOTE: the database has $COUNT applied migration(s) this image does not contain (newest: $NEWEST)."
    echo "Normal after a code rollback; they are left in place."
fi

# Pending = in the image, not applied. Written to a file so minus() can read it as a pattern list.
pending() { printf '%s\n' "$1" > /tmp/applied; minus "$(cat "$KNOWN")" /tmp/applied; }

# Step 1: Check current state
echo ""
echo "=== Pre-migration state ==="
PENDING_BEFORE=$(pending "$APPLIED")
if [ -z "$PENDING_BEFORE" ]; then
    echo "No pending migrations."
else
    echo "Pending migrations:"
    echo "$PENDING_BEFORE"
fi

# Step 2: Apply migrations. The bundle is `dotnet ef database update`: with a target it migrates up
# or down to it (`0` = everything reverted); an unknown target fails with "not found", exit non-zero.
echo ""
echo "=== Applying migrations ==="
if [ -n "$MIGRATE_TARGET" ]; then
    echo "Migrating to target: $MIGRATE_TARGET"
    "$BUNDLE" "$MIGRATE_TARGET"
else
    echo "Applying all pending migrations..."
    "$BUNDLE"
fi

# Step 3: Verify
echo ""
echo "=== Post-migration verification ==="
APPLIED=$(applied)
PENDING_AFTER=$(pending "$APPLIED")

if [ -z "$MIGRATE_TARGET" ]; then
    # Normal case: should have no pending
    if [ -n "$PENDING_AFTER" ]; then
        echo "ERROR: Migrations still pending after update!"
        echo "$PENDING_AFTER"
        exit 1
    fi
    echo "SUCCESS: All migrations applied."
else
    echo "Migration to '$MIGRATE_TARGET' complete."
fi
echo ""
echo "Applied migrations:"
printf '%s\n' "$APPLIED" | grep . || echo "(none)"
if [ -n "$PENDING_AFTER" ]; then
    echo ""
    echo "Pending migrations:"
    echo "$PENDING_AFTER"
fi
