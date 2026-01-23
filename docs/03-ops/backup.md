# Backup & Restore

## What to Backup

| Data | Location | Method |
|------|----------|--------|
| PostgreSQL | `/srv/books/postgres` | pg_dump |
| Book files | `/srv/books/storage` | tar/rsync |

## Database Backup

### Manual
```bash
docker exec books_db pg_dump -U app books > /srv/backups/db-$(date +%F).sql
```

### Restore
```bash
docker exec -i books_db psql -U app books < /srv/backups/db-2024-12-01.sql
```

### Compressed
```bash
# Backup
docker exec books_db pg_dump -U app books | gzip > /srv/backups/db-$(date +%F).sql.gz

# Restore
gunzip -c /srv/backups/db-2024-12-01.sql.gz | docker exec -i books_db psql -U app books
```

## File Storage Backup

### Manual
```bash
tar czf /srv/backups/storage-$(date +%F).tar.gz /srv/books/storage
```

### Restore
```bash
tar xzf /srv/backups/storage-2024-12-01.tar.gz -C /
```

### Incremental (rsync)
```bash
rsync -av /srv/books/storage/ /backup-drive/storage/
```

## Automated Backup

### Cron Script
```bash
#!/bin/bash
# /srv/books/backup.sh

DATE=$(date +%F)
BACKUP_DIR=/srv/backups

# Database
docker exec books_db pg_dump -U app books | gzip > $BACKUP_DIR/db-$DATE.sql.gz

# Storage
tar czf $BACKUP_DIR/storage-$DATE.tar.gz /srv/books/storage

# Cleanup old backups (keep 7 days)
find $BACKUP_DIR -name "*.gz" -mtime +7 -delete
```

### Crontab
```bash
# Daily at 3 AM
0 3 * * * /srv/books/backup.sh
```

## First-Time Setup

```bash
sudo mkdir -p /srv/books/postgres /srv/books/storage /srv/backups
sudo chown -R $USER:$USER /srv/books /srv/backups
```

## Offsite Backup

Recommended: copy backups to external storage.

```bash
# To NAS
rsync -av /srv/backups/ nas:/volume1/books-backup/

# To cloud (rclone)
rclone sync /srv/backups remote:textstack-backup
```

## Disaster Recovery

1. Stop containers: `docker compose down`
2. Restore Postgres data directory (or use pg_dump restore)
3. Restore storage directory
4. Start containers: `docker compose up`
5. Verify: check `/health`, browse books

## See Also

- [Local Development](local-dev.md) — Docker setup
- [ADR-001: Storage](../01-architecture/adr/001-storage-bind-mounts.md)
