#!/bin/sh
set -e

PROJECT="backend/src/Infrastructure/Infrastructure.csproj"
STARTUP="backend/src/Api/Api.csproj"
CONNECTION="$ConnectionStrings__Default"

echo "=== EF Core Migration Runner ==="
echo "Target: ${MIGRATE_TARGET:-latest}"
echo ""

# Function to list pending migrations
list_pending() {
    dotnet ef migrations list \
        --project "$PROJECT" \
        --startup-project "$STARTUP" \
        --connection "$CONNECTION" \
        --no-build 2>/dev/null | grep "(Pending)" || true
}

# Function to list applied migrations
list_applied() {
    dotnet ef migrations list \
        --project "$PROJECT" \
        --startup-project "$STARTUP" \
        --connection "$CONNECTION" \
        --no-build 2>/dev/null | grep -v "(Pending)" | grep -v "^Build" | grep -v "^$" || true
}

# Restore and build
echo "Restoring packages..."
dotnet restore "$STARTUP" -v q

echo "Building project..."
dotnet build "$STARTUP" -c Debug -v q

# Step 0: migrations the DB has applied that this image does not contain (ADR-021).
# EF reverts only what its own assembly knows, so a rollback run by an OLDER image (e.g. after a code
# rollback re-tagged textstack-migrator:latest) reverts nothing and exits 0. Refuse that loudly.
# Without a target this is the normal state after a code rollback: report it, change nothing.
conn_field() { printf '%s' "$CONNECTION" | tr ';' '\n' | sed -n "s/^ *$1=//p" | head -n 1; }
PGHOST=$(conn_field Host); PGPORT=$(conn_field Port); PGDATABASE=$(conn_field Database)
PGUSER=$(conn_field Username); PGPASSWORD=$(conn_field Password)
export PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD

dotnet ef migrations list \
    --project "$PROJECT" \
    --startup-project "$STARTUP" \
    --no-connect \
    --no-build 2>/dev/null | grep -E '^[0-9]{14}_' > /tmp/known-migrations || true
[ -s /tmp/known-migrations ] || { echo "ERROR: could not list this image's migrations"; exit 1; }

# Plain assignments, so a psql failure stops the script (set -e) instead of passing the check.
UNKNOWN=""
HAS_HISTORY=$(psql -XAtc "SELECT to_regclass('\"__EFMigrationsHistory\"') IS NOT NULL")
if [ "$HAS_HISTORY" = "t" ]; then
    APPLIED=$(psql -XAtc 'SELECT migration_id FROM "__EFMigrationsHistory" ORDER BY 1')
    UNKNOWN=$(printf '%s\n' "$APPLIED" | grep -vxF -f /tmp/known-migrations || true)
fi
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

# Step 1: Check current state
echo ""
echo "=== Pre-migration state ==="
PENDING_BEFORE=$(list_pending)
if [ -z "$PENDING_BEFORE" ]; then
    echo "No pending migrations."
else
    echo "Pending migrations:"
    echo "$PENDING_BEFORE"
fi

# Step 2: Apply migrations
echo ""
echo "=== Applying migrations ==="

if [ -n "$MIGRATE_TARGET" ]; then
    echo "Migrating to target: $MIGRATE_TARGET"
    dotnet ef database update "$MIGRATE_TARGET" \
        --project "$PROJECT" \
        --startup-project "$STARTUP" \
        --connection "$CONNECTION" \
        --no-build
else
    echo "Applying all pending migrations..."
    dotnet ef database update \
        --project "$PROJECT" \
        --startup-project "$STARTUP" \
        --connection "$CONNECTION" \
        --no-build
fi

# Step 3: Verify
echo ""
echo "=== Post-migration verification ==="
PENDING_AFTER=$(list_pending)

if [ -z "$MIGRATE_TARGET" ]; then
    # Normal case: should have no pending
    if [ -z "$PENDING_AFTER" ]; then
        echo "SUCCESS: All migrations applied."
        echo ""
        echo "Applied migrations:"
        list_applied
        exit 0
    else
        echo "ERROR: Migrations still pending after update!"
        echo "$PENDING_AFTER"
        exit 1
    fi
else
    # Targeted migration: just report state
    echo "Migration to '$MIGRATE_TARGET' complete."
    echo ""
    echo "Current state:"
    dotnet ef migrations list \
        --project "$PROJECT" \
        --startup-project "$STARTUP" \
        --connection "$CONNECTION" \
        --no-build
    exit 0
fi
