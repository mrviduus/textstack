# Backup & Restore

## What's backed up

| Data | Location (prod) | Method |
|------|----------------|--------|
| PostgreSQL | `./data/postgres-prod` | `pg_dump` inside `textstack_db_prod` → local + R2 |
| Book files | `./data/storage` | `tar` locally; restic → R2 |
| `.env` | repo root on the server | restic → R2 only |

Local copies land in `~/backups/textstack/` on the server; the off-site copy is Cloudflare R2 (see below).

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

`.github/workflows/backup.yml` runs **daily at 03:00 UTC** on the self-hosted runner:

1. `pg_dump` → `~/backups/textstack/db-<YYYY-MM-DD>.sql.gz` (`pipefail` + dump-complete trailer check).
2. `tar czf` of `./data/storage` → `storage-<YYYY-MM-DD>.tar.gz` (tar exit 1 "file changed as we read it" is a warning).
3. Prunes to the **2** newest local copies of each kind (`db-`, `storage-`, `pre-deploy-`) — history lives in R2.
4. `gunzip -t`, then `infra/scripts/backup-verify.sh` restores the new dump into a throwaway pgvector container.
5. **Off-site copy to Cloudflare R2** (below).
6. Queues the nightly full SSG rebuild; then a disk alarm fails the job at ≥85% on `/` or the Docker root.

To trigger manually: GitHub UI → Actions → **Scheduled Backup** → Run workflow.

## Off-site copy — Cloudflare R2 (restic)

The only copy that survives losing the server. restic runs in Docker (`restic/restic:0.17.3`), nothing installed
on the host. Bucket `textstack-backups`, repository encrypted client-side.

- **What:** the DB dump as plain SQL through stdin (`/db.sql` — plain so it deduplicates; a `.gz` re-uploaded
  ~1.2 GB every night), plus `data/storage` and `.env` (`/backup`).
- **Retention:** 7 nightly + 3 monthly. **Guard:** the job fails above 9 GB to stay inside R2's free 10 GB.
- **Secrets (GitHub → Actions):** `RESTIC_REPOSITORY`, `RESTIC_PASSWORD`, `R2_ACCESS_KEY_ID` (32 chars),
  `R2_SECRET_ACCESS_KEY` (64 chars). **`RESTIC_PASSWORD` must also be in the owner's password manager** — without
  it the backup cannot be read, and GitHub will not show a secret back.
- Size on 2026-10-05: ~4.3 GB (two snapshots).

## Restore drill (monthly, automatic)

`.github/workflows/restore-drill.yml` — 1st of each month and on demand. A clean GitHub-hosted runner restores the
latest R2 snapshots with **nothing from the server**: DB into a fresh pgvector postgres (fails if core tables look
truncated), storage + `.env`, then checks 200 random edition covers from the DB exist in the restored files and the
critical `.env` keys are set (names only).

First run, 2026-10-05: **DB 206 s, files 37 s**; 65 tables, 1,423 editions, 40,582 chapters, 313 users;
22,449 files / 4.3 GB; covers 200/200.

## Disaster recovery — server lost

Data takes ~4 min to restore (drill timings). Most of the time is rebuilding the box.

1. **New host:** Docker + compose, the repo cloned to `~/projects/onlinelib/textstack`, `cloudflared` with the
   existing tunnel credentials, the GitHub self-hosted runner, nginx (`make nginx-setup`). x86_64, as prod.
2. **Restore files + `.env` from R2** (any machine with Docker; the 4 values come from the password manager /
   GitHub secrets you re-enter):
   ```bash
   export RESTIC_REPOSITORY=... RESTIC_PASSWORD=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...
   R="docker run --rm -i -e RESTIC_REPOSITORY -e RESTIC_PASSWORD -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -v $PWD:/out restic/restic:0.17.3"
   $R snapshots
   $R restore latest --path /backup --target /out/restore
   cp restore/backup/env .env && mkdir -p data && mv restore/backup/storage data/storage
   ```
3. **Start only the database** and load the dump (prod user from `.env`):
   ```bash
   docker compose up -d db
   $R dump --path /db.sql latest /db.sql \
     | docker exec -i textstack_db_prod psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1
   ```
   Snapshots older than 2026-10-05 hold the dump as `/backup/db.sql.gz` instead:
   `$R dump --path /backup latest /backup/db.sql.gz | gunzip | docker exec -i …`.
4. **Start the rest:** `docker compose --profile mcp -f docker-compose.yml -f docker-compose.gpu.yml up -d`
   (the migrator brings the schema forward if the code is newer than the dump).
5. **Verify:** `curl https://textstack.app/api/health` → `"healthy"`, `/api/health/ready` all ok, open a book,
   then queue a full SSG rebuild (admin → SSG, or `make rebuild-ssg`).

**Data loss window:** up to 24 h (the nightly backup). `pre-deploy-*` dumps on the old box are gone with it.

## See also

- [Local Development](local-dev.md) — Docker setup
- [Uptime Monitoring](uptime-monitoring.md) — `health-check.yml` (every 5 min) probes API +
  frontends; backups are checked by `backup.yml` itself and by the monthly restore drill
