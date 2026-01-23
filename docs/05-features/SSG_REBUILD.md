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
│                  POST /admin/ssg/rebuild                        │
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
│       - Sets status: Queued → Running                           │
│       - Stores job in PostgreSQL                                │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                 PostgreSQL                                      │
│                 Table: ssg_rebuild_jobs                         │
│                 Status: 'Running'                               │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│              ssg_worker container (Node.js)                     │
│              apps/web/scripts/ssg-worker.mjs                    │
│                                                                 │
│  1. Polls DB every 5s for jobs with status='Running'            │
│  2. Fetches routes from API: GET /ssg/routes?site={code}        │
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
| `Domain/Enums/SsgRebuildMode.cs` | Full, Incremental |
| `Application/SsgRebuild/SsgRebuildService.cs` | Creates and manages jobs |
| `Application/SsgRebuild/SsgRouteProvider.cs` | Provides routes to render |
| `Api/Endpoints/AdminSsgRebuildEndpoints.cs` | Admin CRUD endpoints |
| `Api/Endpoints/SsgEndpoints.cs` | Public `/ssg/routes` endpoint |

### Frontend (Node.js)

| File | Purpose |
|------|---------|
| `apps/web/scripts/ssg-worker.mjs` | Background worker polling for jobs |
| `apps/web/scripts/prerender.mjs` | Puppeteer-based page renderer |
| `apps/web/Dockerfile.ssg-worker` | Docker image for ssg_worker |

### Docker Services

```yaml
# docker-compose.yml
ssg_worker:
  build:
    context: ./apps/web
    dockerfile: Dockerfile.ssg-worker
  environment:
    DATABASE_URL: postgres://...
    API_URL: http://api:8080
    API_HOST: textstack.app
```

---

## API Endpoints

### Admin Endpoints (authenticated)

```
POST   /admin/ssg/rebuild              Create new rebuild job
GET    /admin/ssg/jobs                 List all jobs
GET    /admin/ssg/jobs/{id}            Get job details
DELETE /admin/ssg/jobs/{id}            Cancel running job
```

### Public Endpoints

```
GET    /ssg/routes?site={code}         Get routes for prerendering
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
    mode VARCHAR(20) NOT NULL,    -- Full, Incremental
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

## Usage

### Via Admin Panel

1. Open https://textstack.dev/ssg-rebuild
2. Click "New Rebuild"
3. Select site (general/programming)
4. Click "Create"
5. Monitor progress in job list

### Via CLI

```bash
# On production server
make rebuild-ssg

# Or manually
cd apps/web
API_URL=http://localhost:8080 API_HOST=textstack.app node scripts/prerender.mjs
```

### Via CI/CD

SSG prerender runs automatically on deploy (see `.github/workflows/deploy.yml`).

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

**Cause**: ssg_worker container not running or unhealthy.

**Fix**:
```bash
docker ps | grep ssg_worker
docker logs textstack_ssg_worker --tail 50
docker compose restart ssg_worker
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

- [SEO Policy](../02-system/seo-policy.md)
- [SEO Crawler Usage](./SEO_CRAWLER_USAGE.md)
- [Deployment Guide](../03-ops/deployment.md)

---

*Last updated: 2026-01-23*
