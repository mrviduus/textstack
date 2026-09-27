#!/usr/bin/env bash
# Restore a pg_dump backup into a throwaway postgres container and run sanity queries.
# Usage: ./backup-verify.sh <path-to-backup.sql.gz>

set -euo pipefail

BACKUP_FILE="${1:-}"
if [[ -z "$BACKUP_FILE" ]]; then
  echo "Usage: $0 <backup.sql.gz>" >&2
  exit 2
fi
if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "File not found: $BACKUP_FILE" >&2
  exit 2
fi

CONTAINER="textstack_backup_verify_$$"
PORT=$(( 15432 + RANDOM % 1000 ))
PG_USER="verify"
PG_DB="verify"
PG_PASS="verify"

# -v removes the container's ANONYMOUS volume too. postgres declares an
# anonymous VOLUME at /var/lib/postgresql/data, so every run that reaches
# `docker rm -f` (a killed/timed-out run where --rm never fired) otherwise
# leaks a full pgdata volume. 34 days of daily backups leaked 156 GB of these
# and filled the docker data-root — which then broke the very backup that
# creates them. `docker rm -fv` reaps the volume with the container.
cleanup() {
  docker rm -fv "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Reap leaked verify containers (and their orphaned pgdata volumes) from prior
# killed/timed-out runs — they hold ports + memory + disk and can starve a
# fresh postgres into never becoming ready.
LEAKED=$(docker ps -aq --filter "name=textstack_backup_verify_" 2>/dev/null || true)
if [[ -n "$LEAKED" ]]; then
  echo "[verify] removing $(echo "$LEAKED" | wc -l | tr -d ' ') leaked verify container(s) ..." >&2
  docker rm -fv $LEAKED >/dev/null 2>&1 || true
fi
# Belt-and-suspenders: drop any dangling anonymous volumes orphaned before this
# fix (or by an OOM-killed `docker rm`). Named volumes are untouched by prune.
docker volume prune -f >/dev/null 2>&1 || true

echo "[verify] starting postgres on :$PORT ..."
docker run -d --rm \
  --name "$CONTAINER" \
  -e POSTGRES_USER="$PG_USER" \
  -e POSTGRES_PASSWORD="$PG_PASS" \
  -e POSTGRES_DB="$PG_DB" \
  -p "$PORT:5432" \
  pgvector/pgvector:pg16 >/dev/null  # prod schema uses CREATE EXTENSION vector (pgvector); vanilla postgres:16 fails restore

# Dump why the throwaway postgres never came up. "did not become ready" alone
# hides the real cause — almost always a full disk (initdb can't write its data
# dir) or the container dying on start. Print the signal into the CI log.
diagnose_startup_failure() {
  echo "[verify] --- diagnostics: why postgres didn't start ---" >&2
  echo "[verify] container state:" >&2
  docker ps -a --filter "name=$CONTAINER" --format '  {{.Names}} {{.Status}}' >&2 2>&1 || true
  echo "[verify] last container logs:" >&2
  docker logs --tail 40 "$CONTAINER" 2>&1 | sed 's/^/  /' >&2 || true
  echo "[verify] disk usage (a full disk is the usual cause):" >&2
  df -h / /home 2>/dev/null | sed 's/^/  /' >&2 || true
  echo "[verify] docker disk usage:" >&2
  docker system df 2>/dev/null | sed 's/^/  /' >&2 || true
  echo "[verify] -------------------------------------------------" >&2
}

echo "[verify] waiting for postgres to accept connections ..."
# Probe over TCP (-h 127.0.0.1), never the unix socket. The postgres entrypoint
# starts a *bootstrap* server first — initdb, CREATE DATABASE, initdb.d — with
# listen_addresses='' , i.e. unix socket only, then shuts it down before the
# real start. `pg_isready` with no -h talks to that socket, so it answers
# "ready" during bootstrap. That is what failed the 2026-09-27 backup: the wait
# broke out on the bootstrap server and the old re-probe below landed inside
# its ~0.3s shutdown window, reporting "did not become ready after 120s" after
# 1.3 seconds. A TCP listener exists only on the real server, so this cannot
# see the bootstrap one at all.
#
# READY counts *consecutive* hits and resets on a miss: two hits a second apart
# are required, so no single transient listener can satisfy the wait. The old
# break-then-re-probe pattern is gone — it was the race, not a safety net.
READY=0
ELAPSED=0
for i in {1..120}; do
  if docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -p 5432 -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; then
    READY=$((READY + 1))
    if [[ "$READY" -ge 2 ]]; then
      break
    fi
  else
    READY=0
  fi
  # Bail early if the container has already exited — no point waiting 120s.
  if [[ -z "$(docker ps -q --filter "name=$CONTAINER" 2>/dev/null)" ]]; then
    echo "[verify] FAIL: verify container exited during startup" >&2
    diagnose_startup_failure
    exit 1
  fi
  sleep 1
  ELAPSED=$((ELAPSED + 1))
done
if [[ "$READY" -lt 2 ]]; then
  # Report the real elapsed wait. The old message said "after 120s" no matter
  # how long it had actually waited, which sent the first investigation looking
  # for a slow or full disk instead of a race.
  echo "[verify] FAIL: postgres did not accept TCP connections after ${ELAPSED}s" >&2
  diagnose_startup_failure
  exit 1
fi
echo "[verify] postgres ready after ${ELAPSED}s"

echo "[verify] pre-creating roles referenced by dump ..."
docker exec "$CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -c \
  "CREATE ROLE textstack_prod;" >/dev/null 2>&1 || true

echo "[verify] restoring $BACKUP_FILE ..."
# Redirect stderr to catch restore errors; NOTICE/WARNING on reload are normal.
if ! gunzip -c "$BACKUP_FILE" | docker exec -i "$CONTAINER" psql -U "$PG_USER" -d "$PG_DB" --set=ON_ERROR_STOP=on >/dev/null; then
  echo "[verify] FAIL: restore aborted on error" >&2
  exit 1
fi

echo "[verify] running sanity queries ..."
QUERY="
SELECT
  (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public')::int AS tables,
  (SELECT count(*) FROM pg_catalog.pg_class WHERE relkind = 'i' AND relnamespace = 'public'::regnamespace)::int AS indexes,
  COALESCE((SELECT count(*) FROM users), 0)::int AS users,
  COALESCE((SELECT count(*) FROM editions), 0)::int AS editions,
  COALESCE((SELECT count(*) FROM chapters), 0)::int AS chapters;
"
RESULT=$(docker exec "$CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -At -F'|' -c "$QUERY")
IFS='|' read -r TABLES INDEXES USERS EDITIONS CHAPTERS <<< "$RESULT"

echo "[verify] tables=$TABLES indexes=$INDEXES users=$USERS editions=$EDITIONS chapters=$CHAPTERS"

FAIL=0
if [[ "${TABLES:-0}" -lt 10 ]]; then
  echo "[verify] FAIL: too few tables ($TABLES) — schema looks truncated" >&2
  FAIL=1
fi
if [[ "${EDITIONS:-0}" -lt 1 ]]; then
  echo "[verify] FAIL: editions table empty — data loss suspected" >&2
  FAIL=1
fi

if [[ "$FAIL" -eq 0 ]]; then
  echo "[verify] OK"
fi
exit "$FAIL"
