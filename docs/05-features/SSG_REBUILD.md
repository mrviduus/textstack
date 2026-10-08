# SSG Rebuild — Technical Documentation

## Overview

SSG (Static Site Generation) Rebuild is a feature that pre-renders React pages to static HTML for SEO. Search engines receive fully rendered HTML instead of empty `<div id="root"></div>`.

**Problem solved**: SPA pages are invisible to search crawlers → poor SEO rankings.

**Solution**: Pre-render pages at build time or on-demand via admin panel.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        ADMIN PANEL                              │
│                  POST /admin/ssg/jobs (created Queued)          │
│                  (textstack.dev/ssg-rebuild)                    │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                          API                                    │
│                                                                 │
│  AdminSsgRebuildEndpoints.cs                                    │
│       ↓                                                         │
│  SsgRebuildService.cs                                           │
│       - Creates SsgRebuildJob entity                            │
│       - Inserts it Queued (one write)                           │
│       - Stores job in PostgreSQL                                │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                 PostgreSQL                                      │
│                 Table: ssg_rebuild_jobs                         │
│                 Status: 'Queued'                                │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│              ssg_worker container (Node.js)                     │
│              apps/web/scripts/ssg-worker.mjs                    │
│                                                                 │
│  0. At startup: Running rows → Failed (interrupted)             │
│  1. Every 5s claims the oldest Queued job → Running (SKIP LOCKED)│
│  2. Fetches routes from API: GET /ssg/routes (site from Host)    │
│  3. Spawns prerender.mjs with routes                            │
│  4. Updates job progress (rendered_count, failed_count)         │
│  5. Sets final status: Completed or Failed                      │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                    prerender.mjs                                │
│                                                                 │
│  1. Starts local static server with API proxy                   │
│  2. Launches Puppeteer (headless Chrome)                        │
│  3. Visits each route, waits for React hydration                │
│  4. Extracts rendered HTML                                      │
│  5. Saves to dist/ssg/{route}/index.html                        │
└─────────────────────────────────────────────────────────────────┘
```

---

## Components

### Backend (.NET)

| File | Purpose |
|------|---------|
| `Domain/Entities/SsgRebuildJob.cs` | Job entity with status, progress, timestamps |
| `Domain/Entities/SsgRebuildResult.cs` | Individual route render results |
| `Domain/Enums/SsgRebuildJobStatus.cs` | Queued, Running, Completed, Failed, Cancelled |
| `Domain/Enums/SsgRebuildMode.cs` | Full only (Incremental and Specific removed 2026-10-08) |
| `Application/SsgRebuild/SsgRebuildService.cs` | Creates and manages jobs |
| `Application/SsgRebuild/SsgRouteProvider.cs` | Provides routes to render |
| `Api/Endpoints/AdminSsgRebuildEndpoints.cs` | Admin CRUD endpoints |
| `Api/Endpoints/SsgEndpoints.cs` | Public `/ssg/routes` endpoint |
| `Api/Endpoints/InternalEndpoints.cs` | `POST /internal/ssg/rebuild-all` (used by deploy) |

### Frontend (Node.js)

| File | Purpose |
|------|---------|
| `apps/web/scripts/ssg-worker.mjs` | Background worker polling for jobs |
| `apps/web/scripts/prerender.mjs` | Puppeteer-based page renderer |
| `apps/web/Dockerfile.ssg-worker` | Docker image for ssg_worker |

### Docker Services

```yaml
# docker-compose.yml
ssg-worker:
  build:
    context: .                       # repo root (pnpm workspace catalog)
    dockerfile: apps/web/Dockerfile.ssg-worker
  init: true                         # tini reaps Chromium zombies
  environment:
    DATABASE_URL: postgres://...
    API_URL: http://api:8080
    API_HOST: localhost
    POLL_INTERVAL: "5000"
    INDEXNOW_KEY / INDEXNOW_ENABLED  # IndexNow pings (Bing/Yandex)
```

---

## API Endpoints

### Admin Endpoints (authenticated)

```
GET    /admin/ssg/preview              Preview routes
POST   /admin/ssg/jobs                 Create job
GET    /admin/ssg/jobs                 List jobs
GET    /admin/ssg/jobs/{id}            Job details
POST   /admin/ssg/jobs/{id}/cancel     Cancel
GET    /admin/ssg/jobs/{id}/stats      Stats
GET    /admin/ssg/jobs/{id}/results    Per-route results
```

### Public Endpoints

```
GET    /ssg/routes                     Get routes for prerendering (site from Host header)
GET    /ssg/books                      Get all book slugs
GET    /ssg/authors                    Get all author slugs
GET    /ssg/genres                     Get all genre slugs
```

---

## Database Schema

```sql
CREATE TABLE ssg_rebuild_jobs (
    id UUID PRIMARY KEY,
    site_id UUID NOT NULL REFERENCES sites(id),
    status VARCHAR(20) NOT NULL,  -- Queued, Running, Completed, Failed, Cancelled
    mode VARCHAR(20) NOT NULL,    -- Full (legacy values read as Full)
    total_routes INT,
    rendered_count INT DEFAULT 0,
    failed_count INT DEFAULT 0,
    concurrency INT DEFAULT 4,
    timeout_ms INT DEFAULT 30000,
    book_slugs_json TEXT,         -- JSON array for incremental
    author_slugs_json TEXT,
    genre_slugs_json TEXT,
    error TEXT,
    created_at TIMESTAMP NOT NULL,
    started_at TIMESTAMP,
    finished_at TIMESTAMP
);
```

---

## Atomic Swap

SSG rebuild uses atomic swap for zero-downtime updates:

```
1. Build     → dist/ssg-new/
2. Rename    → dist/ssg/ → dist/ssg-old/
3. Rename    → dist/ssg-new/ → dist/ssg/
4. Delete    → dist/ssg-old/
```

**Benefits:**
- Zero downtime during rebuild
- Orphan files automatically cleaned (deleted books, old routes)
- Rollback possible (keep ssg-old before step 4)

**Disk space:** ~100MB during rebuild (2x normal)

**Cleanup command:**
```bash
make clean-ssg  # Removes ssg, ssg-new, ssg-old
```

---

## Usage

### Via Admin Panel

1. Open https://textstack.dev/ssg-rebuild
2. Click "New Rebuild"
3. Pick mode, click "Create"
4. Monitor progress in job list

### Via CLI

```bash
# On production server: queues a Full job (POST /internal/ssg/rebuild-all) and follows it.
# Exit 0 only when the job ends Completed. Ctrl-C stops following, not the job.
# Exit 1 if ssg-worker does not start it in 5 min or it stops moving for 30 min (worker down).
# A Full rebuild already Queued is followed; a Running one is waited out, then a new one is queued.
make rebuild-ssg
```

Do not run `scripts/prerender.mjs` by hand on the server: it writes straight into `dist/ssg` with none
of the worker's checks.

### Via CI/CD

`backup.yml` queues the nightly Full rebuild (`POST /internal/ssg/rebuild-all`); `deploy.yml` queues one only when run with `rebuild_ssg`. `health-check.yml` alarms on a failed or >72h-stale rebuild.

---

## When to Rebuild

**Automatic (via CI/CD):**
- Every deployment to main branch

**Manual (via Admin or CLI):**
- After adding/publishing new books
- After updating book metadata (title, description, cover)
- After adding/updating authors or genres
- After changing SEO fields

**Not needed:**
- Reading progress changes
- User bookmarks
- Library saves

---

## Troubleshooting

### Job stuck at 0% / Failed immediately

**Cause**: ssg-worker container not running or unhealthy (healthcheck also fails if the last job was `Failed`).

**Fix**:
```bash
docker ps | grep ssg_worker
docker logs textstack_ssg_worker --tail 50
docker compose restart ssg-worker
```

### Routes not updating after publish

**Cause**: SSG cache not rebuilt.

**Fix**: Create new rebuild job in admin panel or run `make rebuild-ssg`.

### Prerender fails on specific routes

**Check logs**:
```bash
docker logs textstack_ssg_worker 2>&1 | grep -i error
```

Common issues:
- API returning 500 → check API logs
- Timeout → increase timeout_ms in job
- Memory issues → reduce concurrency

---

## Development History

### Initial Problem (Jan 2026)

SSG rebuild from admin panel failed on production with 0% progress. Investigation revealed:

1. **Two workers competing for same jobs**:
   - .NET Worker (`SsgRebuildWorkerService.cs`)
   - Node.js Worker (`ssg-worker.mjs`)

2. **.NET Worker had Node.js but no prerender script**:
   ```
   docker exec textstack_worker_prod which node  → /usr/bin/node ✓
   docker exec textstack_worker_prod ls apps/web/scripts/prerender.mjs  → NOT FOUND ✗
   ```

3. **Race condition**: .NET worker picked up jobs first, attempted to spawn `node prerender.mjs`, failed because script wasn't in container.

### Solution

1. **Removed duplicate code** from .NET Worker:
   - Deleted `SsgRebuildWorkerService.cs` (443 lines)
   - Deleted `SsgRebuildWorker.cs`

2. **Single source of truth**: Only `ssg_worker` container handles SSG jobs.

### Lessons Learned

1. **Don't duplicate functionality** across different tech stacks
2. **Check full environment** when debugging (node existed, script didn't)
3. **Clear ownership**: One service = one responsibility

---

## Related Documentation

- [SEO implementation](../02-system/seo-implementation.md) · [SSG prerender](../02-system/ssg-prerender.md)
- [Deployment Guide](../03-ops/deployment.md)

---

*Last updated: 2026-01-23; endpoints/compose re-checked 2026-10-04*
