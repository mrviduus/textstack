# Backup & Restore

## What's backed up

| Data | Location (prod) | Method |
|------|----------------|--------|
| PostgreSQL | `./data/postgres-prod` | `pg_dump` inside `textstack_db_prod` |
| Book files | `./data/storage` | `tar` of the bind mount |

Backups land in `~/backups/textstack/` on the server (override via
`BACKUP_DIR` env on the Make invocation if needed).

## Commands

All day-to-day backup flows go through the Makefile — it already knows the
container name + credentials from `.env`.

```bash
make backup                       # pg_dump → ~/backups/textstack/db_<ts>.sql.gz
make backup-list                  # list existing backups
make backup-verify                # restore latest dump into throwaway pg + sanity queries
make backup-verify FILE=<path>    # verify specific backup
make restore FILE=~/backups/textstack/db_2026-04-22_030012.sql.gz
```

`backup-verify` spins up `pgvector/pgvector:pg16` on a random port (vanilla `postgres:16` fails: the schema still has `CREATE EXTENSION vector`), loads the gzipped
dump with `ON_ERROR_STOP`, then runs a sanity SELECT over tables/editions/
chapters. Exits non-zero if restore aborts or core tables look truncated.
The throwaway container is removed on exit.

Under the hood `make backup` runs:
```bash
docker exec textstack_db_prod pg_dump -U $POSTGRES_USER $POSTGRES_DB \
  | gzip > ~/backups/textstack/db_$(date +%Y-%m-%d_%H%M%S).sql.gz
```

## Automated backup (GitHub Actions)

`.github/workflows/backup.yml` runs **daily at 03:00 UTC** on the self-hosted
runner:

1. `pg_dump` → `~/backups/textstack/db-<YYYY-MM-DD>.sql.gz` (dash, date only — unlike `make backup`)
2. `tar czf` the `./data/storage` directory → `storage-<YYYY-MM-DD>.tar.gz`
3. Prunes to the 5 newest of each kind (`db-`, `storage-`, and the `pre-deploy-` dumps `deploy.yml` writes).
4. `gunzip -t`, then `infra/scripts/backup-verify.sh` on the new dump.

To trigger manually: GitHub UI → Actions → **Backup** → Run workflow.

## File storage backup (manual, rarely needed)

```bash
tar czf ~/backups/textstack/storage_$(date +%F).tar.gz ./data/storage
```

Restore:
```bash
tar xzf ~/backups/textstack/storage_2026-04-22.tar.gz -C /
```

Incremental via rsync:
```bash
rsync -av ./data/storage/ /backup-drive/storage/
```

## Offsite copy (optional)

```bash
rsync -av ~/backups/textstack/ nas:/volume1/textstack-backup/
# or
rclone sync ~/backups/textstack remote:textstack-backup
```

## Disaster recovery

1. `docker compose down`
2. Restore DB: `make restore FILE=~/backups/textstack/db_<ts>.sql.gz` (or
   raw `gunzip -c … | docker exec -i textstack_db_prod psql -U app books`).
3. Restore storage: `tar xzf storage_<ts>.tar.gz -C /`
4. `docker compose up -d`
5. Verify: `curl https://textstack.app/api/health` returns `healthy`;
   browse a book page.

## Restore verification (quarterly)

Backups are useless if they don't restore. Recommended cadence: restore the
latest backup to a disposable postgres container and run smoke queries.

```bash
# Spin up ephemeral postgres
docker run --rm -d --name tmp-restore -e POSTGRES_PASSWORD=x -p 55432:5432 pgvector/pgvector:pg16

# Restore latest dump
gunzip -c $(ls -t ~/backups/textstack/db[-_]*.sql.gz | head -1) \
  | docker exec -i tmp-restore psql -U postgres

# Smoke-queries
docker exec tmp-restore psql -U postgres -c "SELECT COUNT(*) FROM editions;"
docker exec tmp-restore psql -U postgres -c "SELECT COUNT(*) FROM users;"

# Teardown
docker stop tmp-restore
```

## See also

- [Local Development](local-dev.md) — Docker setup
- [Uptime Monitoring](uptime-monitoring.md) — `health-check.yml` (every 5 min) probes API +
  frontends; it does not check backups
