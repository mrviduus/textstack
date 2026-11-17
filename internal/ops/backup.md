# Backup & Restore

## What's backed up

| Data | Location (prod) | Method |
|------|----------------|--------|
| PostgreSQL | `./data/postgres-prod` | `pg_dump` inside `textstack_db_prod` → local + R2 |
| Book files | `./data/storage` | `tar` locally; restic → R2 |
| V2 library (`Storage:LibraryRoot`) | `./data/library` | `tar` locally (same archive); restic → R2 |
| `.env` | repo root on the server | restic → R2 only |

Local copies land in `~/backups/textstack/` on the server; the off-site copy is Cloudflare R2 (see below).

## Commands

All day-to-day backup flows go through the Makefile — it already knows the
container name + credentials from `.env`.

```bash
make backup                       # pg_dump textstack_v2 → ~/backups/textstack/textstack_v2-db_<ts>.sql.gz
make backup-list                  # list existing V2 backups
make backup-verify                # restore latest V2 dump into throwaway pg + sanity queries
make backup-verify FILE=<path>    # verify specific backup
make restore FILE=~/backups/textstack/textstack_v2-db_2026-11-17_030012.sql.gz   # into an absent V2 database
```

V2 only since M6 O1: legacy is read-only and archived. `backup-verify` spins up `pgvector/pgvector:pg16` (prod's
db image) on a random port, loads the gzipped dump with `ON_ERROR_STOP`, then counts tables and `users`, `books`,
`book_files`, `annotations`. Exits non-zero if restore aborts, the schema looks truncated or a core table is empty.
The throwaway container is removed on exit. `make backup` runs `infra/scripts/pg-dump-checked.sh` (`pipefail` +
dump-complete trailer).

## Automated backup (GitHub Actions)

`.github/workflows/backup.yml` runs **daily at 03:00 UTC** on the self-hosted runner:

1. The V2 database → `textstack_v2-db-<YYYY-MM-DD>.sql.gz` (`pipefail` + dump-complete trailer check). A
   failed or missing dump turns the job red ([database/v2/README.md § Backups](../../database/v2/README.md#backups-1043)).
2. `infra/scripts/backup-files-tar.sh`: `tar czf` of `./data/storage` and `./data/library` (a notice while the
   latter does not exist) → `storage-<YYYY-MM-DD>.tar.gz`. Tar exit 1 "file changed as we read it" is a warning; an
   unreadable file fails the job.
3. Prunes to the **2** newest local copies of each kind (`storage-`, `textstack_v2-db-`,
   `textstack_v2-pre-deploy-`) — history lives in R2. Legacy `db-`/`pre-deploy-` files from before M6 O1 are left alone.
4. `gunzip -t`, then `infra/scripts/backup-verify.sh` restores the new dump into a throwaway pgvector container.
5. **Off-site copy to Cloudflare R2** (below).
6. Queues the nightly full SSG rebuild; then a disk alarm fails the job at ≥85% on `/` or the Docker root.

To trigger manually: GitHub UI → Actions → **Scheduled Backup** → Run workflow.

## Off-site copy — Cloudflare R2 (restic)

The only copy that survives losing the server. restic runs in Docker (`restic/restic:0.17.3`), nothing installed
on the host. Bucket `textstack-backups`, repository encrypted client-side.

- **What:** the V2 dump as plain SQL through stdin (`/db_v2.sql` — plain so it deduplicates; a `.gz` re-uploaded
  all of it every night), plus `data/storage`, `data/library` and `.env` (`/backup`). The legacy `/db.sql` is no
  longer sent (M6 O1); `forget` keeps per path, so its last snapshots stay in R2.
- **Retention:** 7 nightly + 3 monthly. **Guard:** the job fails above 9 GB to stay inside R2's free 10 GB.
- **Secrets (GitHub → Actions):** `RESTIC_REPOSITORY`, `RESTIC_PASSWORD`, `R2_ACCESS_KEY_ID` (32 chars),
  `R2_SECRET_ACCESS_KEY` (64 chars). **`RESTIC_PASSWORD` must also be in the owner's password manager** — without
  it the backup cannot be read, and GitHub will not show a secret back.
- Size on 2026-10-05: ~4.3 GB (two snapshots).

## Restore drill (monthly, automatic)

`.github/workflows/restore-drill.yml` — 1st of each month and on demand. A clean GitHub-hosted runner restores the
latest R2 snapshots with **nothing from the server**: the V2 DB into a fresh postgres (counts every migrated table;
fails if `users`, `books`, `book_files` or `annotations` is empty), storage + `.env`, then checks 200 random current
book files from the DB exist in the restored library and the critical `.env` keys are set (names only). The legacy
restore and the ETL rehearsal went with M6 O1.

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
   mkdir -p data/library && { [ ! -d restore/backup/library ] || cp -a restore/backup/library/. data/library/; }   # snapshots before #1110 have none
   ```
3. **Start only the database** and load the V2 dump into an empty database created the way `migrator-v2` does
   (prod user from `.env`):
   ```bash
   set -a; . ./.env; set +a   # POSTGRES_USER, V2_POSTGRES_DB
   docker compose up -d db
   docker compose run --rm migrator-v2 create
   $R dump --path /db_v2.sql latest /db_v2.sql \
     | docker exec -i textstack_db_prod psql -U "$POSTGRES_USER" -d "${V2_POSTGRES_DB:-textstack_v2}" -v ON_ERROR_STOP=1
   ```
   Legacy (read-only, archived) is no longer in the nightly backup since M6 O1; until M6 removes the code that
   still opens it, the last `/db.sql` snapshot or the owner's archive copy is loaded the same way into `$POSTGRES_DB`.
4. **Start the rest:** `docker compose --profile mcp -f docker-compose.yml -f docker-compose.gpu.yml up -d`
   (the migrator brings the schema forward if the code is newer than the dump).
5. **Verify:** `curl https://textstack.app/api/health` → `"healthy"`, `/api/health/ready` all ok, open a book,
   then queue a full SSG rebuild (admin → SSG, or `make rebuild-ssg`).

**Data loss window:** up to 24 h (the nightly backup). `pre-deploy-*` dumps on the old box are gone with it.

## See also

- [Local Development](../../docs/start/run-locally.md) — Docker setup
- [Uptime Monitoring](uptime-monitoring.md) — `health-check.yml` (every 5 min) probes API +
  frontends; backups are checked by `backup.yml` itself and by the monthly restore drill
