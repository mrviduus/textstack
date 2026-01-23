# TextStack Import Guide

Import public domain books from Standard Ebooks format into TextStack.

## Overview

**Flow:**
1. Import books → Creates as **Draft** (not visible to users)
2. Review in Admin → Edit title, author, SEO fields
3. Publish → Makes visible + indexes for search

## Setup

### Docker Compose Volume

The `docker-compose.yml` has this volume mount:
```yaml
volumes:
  - ${TEXTSTACK_PATH:-./data/textstack}:/data/textstack:ro
```

**Usage:**
```bash
# Point to your books folder
TEXTSTACK_PATH=/path/to/standardebooks docker compose up -d api

# Or create symlink (simpler)
ln -s /path/to/standardebooks ./data/textstack
docker compose up -d api
```

## Batch Import Workflow

For 1000+ books, import in batches of 50:

### Step 1: Create a Working Folder

```bash
# Create temp folder for batch
mkdir -p /tmp/textstack-batch

# Copy first 50 books
ls /path/to/standardebooks | head -50 | while read dir; do
  cp -r "/path/to/standardebooks/$dir" /tmp/textstack-batch/
done
```

### Step 2: Run Import

```bash
# Point to batch folder
TEXTSTACK_PATH=/tmp/textstack-batch docker compose up -d api

# Wait for container to start
sleep 5

# Run import
curl -X POST "http://localhost:8080/admin/import/textstack" \
  -H "Content-Type: application/json" \
  -d '{"siteId":"11111111-1111-1111-1111-111111111111","path":"/data/textstack"}'
```

### Step 3: Review Results

```bash
# Check import results (shows imported/skipped/errors)
curl -s "http://localhost:8080/admin/import/textstack" ... | jq '.imported, .skipped, .total'

# View drafts in admin
open http://localhost:81/editions?status=draft
```

### Step 4: Clean Up and Next Batch

```bash
# Clear batch folder
rm -rf /tmp/textstack-batch/*

# Copy next 50 (skip already imported)
ls /path/to/standardebooks | tail -n +51 | head -50 | while read dir; do
  cp -r "/path/to/standardebooks/$dir" /tmp/textstack-batch/
done

# Repeat import
```

## Batch Script

Save as `scripts/import-batch.sh`:

```bash
#!/bin/bash
set -e

SOURCE_DIR="${1:-/path/to/standardebooks}"
BATCH_SIZE="${2:-50}"
BATCH_DIR="/tmp/textstack-batch"
SITE_ID="11111111-1111-1111-1111-111111111111"

# Get already imported identifiers
IMPORTED=$(docker exec books_db psql -U app -d books -t -c \
  "SELECT identifier FROM text_stack_imports;" | tr -d ' ')

# Clear batch dir
rm -rf "$BATCH_DIR"
mkdir -p "$BATCH_DIR"

# Copy unimported books
count=0
for dir in "$SOURCE_DIR"/*/; do
  name=$(basename "$dir")

  # Skip if already imported
  if echo "$IMPORTED" | grep -q "^$name$"; then
    continue
  fi

  # Skip if no OPF file
  if [ ! -f "$dir/src/epub/content.opf" ]; then
    continue
  fi

  cp -r "$dir" "$BATCH_DIR/"
  ((count++))

  if [ $count -ge $BATCH_SIZE ]; then
    break
  fi
done

echo "Prepared $count books for import"

if [ $count -eq 0 ]; then
  echo "No new books to import"
  exit 0
fi

# Restart API with batch folder
TEXTSTACK_PATH="$BATCH_DIR" docker compose up -d api
sleep 5

# Run import
curl -s -X POST "http://localhost:8080/admin/import/textstack" \
  -H "Content-Type: application/json" \
  -d "{\"siteId\":\"$SITE_ID\",\"path\":\"/data/textstack\"}" | jq '.'

echo "Import complete. Review drafts in admin."
```

Usage:
```bash
chmod +x scripts/import-batch.sh
./scripts/import-batch.sh /path/to/standardebooks 50
```

## Production Import

### Option A: Via SSH + SCP

```bash
# From local machine
scp -r /path/to/batch user@server:/tmp/textstack/

# On server
ssh user@server
TEXTSTACK_PATH=/tmp/textstack docker compose up -d api
docker exec textstack_api_prod curl -X POST "http://localhost:8080/admin/import/textstack" \
  -H "Content-Type: application/json" \
  -d '{"siteId":"...","path":"/data/textstack"}'
```

### Option B: Git Submodule (Recommended)

```bash
# Add standardebooks as submodule
git submodule add https://github.com/user/standardebooks.git data/textstack

# On prod, update submodule
git submodule update --init
docker compose up -d api
# Run import...
```

## Admin Workflow

After import, books are in Draft status:

1. **List drafts**: `GET /admin/editions?status=draft`
2. **Edit edition**: `PUT /admin/editions/{id}` - update title, SEO
3. **Publish**: `POST /admin/editions/{id}/publish` - makes visible + indexes for search

### Bulk Publish (SQL)

```sql
-- Publish all drafts (use with caution)
UPDATE editions
SET status = 1, published_at = NOW(), updated_at = NOW()
WHERE status = 0 AND is_public_domain = true;
```

Note: This doesn't index for search. Better to publish via API one by one.

## Troubleshooting

### Check Import Status

```sql
-- Count imported books
SELECT COUNT(*) FROM text_stack_imports;

-- List recent imports
SELECT identifier, imported_at FROM text_stack_imports ORDER BY imported_at DESC LIMIT 10;

-- Count by status
SELECT status, COUNT(*) FROM editions WHERE is_public_domain = true GROUP BY status;
```

### Re-import Failed Book

```sql
-- Delete import record to allow re-import
DELETE FROM text_stack_imports WHERE identifier = 'book-folder-name';
```

### Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| "Directory not found" | TEXTSTACK_PATH not set | Set env var or create symlink |
| "No author found" | OPF parsing issue | Check content.opf format |
| "duplicate key" | Same book imported twice | Already imported, skip |
| 0 chapters | Chapter files not matching | Check TOC structure |

## File Structure Expected

```
book-folder/
├── src/epub/
│   ├── content.opf      # Metadata (title, author, genres)
│   ├── toc.xhtml        # Table of contents
│   └── text/
│       ├── chapter-1.xhtml
│       ├── chapter-2.xhtml
│       └── ...
└── images/
    └── cover.jpg        # Optional cover image
```

## API Reference

### Import Endpoint

```
POST /admin/import/textstack
Content-Type: application/json

{
  "siteId": "11111111-1111-1111-1111-111111111111",
  "path": "/data/textstack"  // Optional, defaults to /data/textstack
}

Response:
{
  "imported": 45,
  "skipped": 5,
  "total": 50,
  "results": [
    {"path": "book-name", "editionId": "...", "chapterCount": 12, "skipped": false, "error": null},
    ...
  ]
}
```

### Publish Endpoint

```
POST /admin/editions/{id}/publish

Response: 200 OK or error
```
