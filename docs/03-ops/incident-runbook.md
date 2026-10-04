# Incident Runbook

First-response steps for common production incidents. All commands run on the
prod server (`ssh asus` → `~/projects/onlinelib/textstack`).

## Diagnosis cheatsheet

```bash
docker compose ps                       # which containers are up/healthy
docker compose logs --tail=100 <svc>    # recent logs
docker compose logs -f <svc>            # tail live
docker stats --no-stream                # CPU/mem per container
df -h / /mnt/data                       # disk space — prod docker data-root is /mnt/data
```

Health endpoints:
- `curl -sS https://textstack.app/api/health` → `healthy` (liveness)
- `curl -sS https://textstack.app/api/health/ready | jq` → per-component
  status: `db`, `storage`, `ollama`. `503` if db/storage down (critical);
  ollama-down still returns `200` with `status: degraded` since distractors
  are soft-fail.
- `docker compose ps` → all services show `(healthy)`
- GitHub Actions → **Health Check** workflow for external view

---

## 1. Public site returns 5xx / down

**Symptom**: UptimeRobot pages on `textstack.app/`. Users report blank page.

1. `curl -I https://textstack.app/` — Cloudflare edge reachable?
2. If 5xx from Cloudflare → check **cloudflared** service on host:
   `systemctl --user status cloudflared` (or wherever it's run).
3. If tunnel OK → check nginx: `sudo systemctl status nginx` + `sudo tail -50 /var/log/nginx/error.log`.
4. If nginx fine → `docker compose ps` and look for unhealthy containers.
5. SSG cache is atomic — if `apps/web/dist/ssg/` exists nginx serves static;
   bot UA without SSG falls back to SPA. Neither should 5xx.

**Escalation**: if Cloudflare Tunnel is down → check tunnel logs, restart
`cloudflared`; meanwhile public site is unreachable (no DNS bypass available).

---

## 2. `/api/health` returns 503

**Symptom**: UptimeRobot keyword monitor fails (`healthy` not in body) or
`/api/health` returns 503.

```bash
docker compose ps db api
docker compose logs --tail=100 api db
docker compose exec db pg_isready -U textstack_prod -d textstack_prod
```

Likely causes:
- DB container unhealthy → see §3.
- API container crash-looping → `docker compose logs api` for stack trace.
  Restart: `docker compose restart api`.
- Migrations pending/failed → `docker compose logs migrator` (should exit 0).

---

## 3. Postgres down / unhealthy

**Symptom**: `db` container not running, or `(unhealthy)`, or API logs show
`Npgsql.NpgsqlException`.

```bash
docker compose ps db
docker compose logs --tail=200 db
docker compose exec db pg_isready -U textstack_prod -d textstack_prod   # or fails
df -h ./data/postgres-prod                          # disk full?
```

First-response:
1. **Disk full** → most common cause. Free space (`docker system prune`,
   rotate old backups in `~/backups/textstack/`, move logs).
2. **Corruption** → `pg_isready` succeeds but queries fail. Check
   `docker compose logs db | tail -50` for `PANIC` / `FATAL`.
3. **Restart DB**: `docker compose restart db`. Wait 30s, verify healthcheck.
4. **Restore from backup** (last resort, data loss):
   `make restore FILE=~/backups/textstack/db_<latest>.sql.gz`.
   See [backup.md](backup.md).

---

## 4. Worker stuck / ingestion not processing

**Symptom**: Uploads stuck in `Pending`, admin queue not draining, or worker
container shows `(unhealthy)`.

```bash
docker compose ps worker
docker compose logs --tail=200 worker
docker compose exec worker ls -la /tmp/worker-alive
```

Worker health is a heartbeat file (`/tmp/worker-alive` inside container,
touched every 30s by `HeartbeatWorker`). 2min-old file = unhealthy.

First-response:
1. **OOM** → check `dmesg | tail` or `docker events --since=1h | grep OOM`.
   Worker limit is 2G (`docker-compose.yml`). Book ingestion can spike.
2. **Deadlock in EF query** → logs show hang. Restart: `docker compose restart worker`.
3. **Stuck job in DB** → check:
   ```sql
   SELECT id, status, started_at, created_at
   FROM ingestion_jobs
   WHERE status = 1            -- int enum JobStatus: 0 Queued, 1 Processing, 2 Succeeded, 3 Failed
   ORDER BY started_at DESC;
   ```
   Jobs older than 30min = stuck. Reset via admin panel → Jobs queue → Retry.

---

## 5. SSG not rebuilding / stale pages

**Symptom**: Newly published book missing from sitemap; author page shows old
data after edit.

```bash
docker compose ps ssg-worker
docker compose logs --tail=200 ssg-worker
```

```sql
-- pending jobs?
SELECT id, status, started_at, rendered_count, total_routes, error
FROM ssg_rebuild_jobs
ORDER BY created_at DESC LIMIT 5;   -- id is a uuid
```

First-response:
0. The `ssg-worker` healthcheck now also fails when the **last job** was `Failed`
   (`/tmp/ssg-worker-last-job`), so `(unhealthy)` can mean "running but failing".
1. **`Running` stuck** → heartbeat file stale (`/tmp/ssg-worker-alive` older
   than 2min). Restart: `docker compose restart ssg-worker`.
2. **Puppeteer crash** → logs show `Protocol error` or similar. Usually
   OOM or chromium version mismatch after base-image update.
3. **Manual trigger**: admin panel → SSG Rebuild → trigger new job. Or
   `make rebuild-ssg`.
4. **Atomic swap failed** → `apps/web/dist/ssg-new` still present. Next
   successful run cleans up.

---

## 6. Nginx serves SPA to bots (SEO regression)

**Symptom**: `curl -I -A "Googlebot" https://textstack.app/en/books/foo`
returns `X-SEO-Render: spa` instead of `ssg`.

Root cause: SSG dist missing or bot regex mismatch.

```bash
ls -la apps/web/dist/ssg/ | head -10   # should have index.html files
grep -n "SSG_BOT_UA\|map.*bot" infra/nginx/textstack.conf
```

Fix:
1. Rebuild SSG: `make rebuild-ssg`.
2. Reload nginx: `sudo systemctl reload nginx`.

---

## 7. Admin panel login loop / 401

**Symptom**: Correct password but redirects to login.

```bash
docker compose logs api --tail=100 | grep -i "admin\|jwt"
```

Likely causes:
- **JWT secret changed** → refresh tokens invalid. Users re-login.
- **Refresh token GC removed active token** → unlikely; GC only deletes
  `ExpiresAt < now`.
- **Clock skew** between client/server > 15min (access token TTL).

Hard-reset: admin user runs `/auth/logout` then logs in fresh.

---

## 8. Disk filling up fast

```bash
df -h /
du -sh ./data/* ~/backups/textstack/* 2>/dev/null | sort -h | tail
docker system df            # prod docker data-root is /mnt/data, not /var/lib/docker
```

Common culprits:
- `./data/storage/books/` — uploaded EPUB/PDF originals + covers. Large.
- `./data/tts-cache/` — 1GB cap but check `du -sh`. Also `explain-cache/`, `translate-cache/`.
- `./data/ollama/` — model weights, multi-GB.
- Docker data-root (`/mnt/data` on prod) — `docker system prune -a --volumes` (careful: nukes
  stopped containers + unused volumes). Orphaned pgdata volumes from `backup-verify` once
  leaked 156G here.
- `~/backups/textstack/` — rotate manually; GHA keeps 5 newest.

---

## Escalation contacts

- Admin email (from `.env`): `${ADMIN_ALERT_EMAIL}`
- SEO backfill failures: sent via Resend to same address
- GitHub repo: <https://github.com/mrviduus/textstack>

## See also

- [Backup & Restore](backup.md) — DR procedure, restore drill
- [Uptime Monitoring](uptime-monitoring.md) — external probes
- [Deployment](deployment.md) — full prod architecture
