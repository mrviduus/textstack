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
