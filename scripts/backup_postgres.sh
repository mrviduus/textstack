#!/bin/bash
set -e

# PostgreSQL Backup Script

CONTAINER="${POSTGRES_CONTAINER:-textstack_db_prod}"
USER="${POSTGRES_USER:-textstack_prod}"
DB="${POSTGRES_DB:-textstack_prod}"
BACKUP_DIR="${BACKUP_DIR:-$(dirname "$0")/../backups}"
KEEP="${BACKUP_KEEP:-7}"

mkdir -p "$BACKUP_DIR"
FILE="$BACKUP_DIR/db_$(date +%Y-%m-%d_%H%M%S).sql.gz"

echo "Backing up $DB from $CONTAINER..."

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
    echo "ERROR: Container '$CONTAINER' not running"
    exit 1
fi

docker exec "$CONTAINER" pg_dump -U "$USER" "$DB" | gzip > "$FILE"

if [ ! -s "$FILE" ]; then
    echo "ERROR: Backup failed"
    rm -f "$FILE"
    exit 1
fi

echo "Saved: $FILE ($(ls -lh "$FILE" | awk '{print $5}'))"

if [ "$KEEP" -gt 0 ]; then
    COUNT=$(find "$BACKUP_DIR" -name "db_*.sql.gz" -type f | wc -l | tr -d ' ')
    if [ "$COUNT" -gt "$KEEP" ]; then
        find "$BACKUP_DIR" -name "db_*.sql.gz" -type f | sort | head -n $((COUNT - KEEP)) | xargs rm -f
        echo "Rotated, keeping last $KEEP"
    fi
fi
