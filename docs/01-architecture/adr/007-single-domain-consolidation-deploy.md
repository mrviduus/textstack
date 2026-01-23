# ADR-007: Production Deployment Guide

## What Changed (Dev)

1. **Removed multisite code** - no more `getSites()`, using `DEFAULT_SITE_ID`
2. **Admin panel simplified** - removed Sites page, added Tools page
3. **Fixed admin API auth** - added `credentials: 'include'` to all fetch calls
4. **Migration ready** - `20260120000000_MergeProgrammingToGeneral.cs`

---

## Production Deployment Steps

### 1. Backup Database (CRITICAL)

```bash
make backup-prod
# Verify backup exists and is recent
ls -la backups/
```

### 2. Update nginx Config

Edit `/etc/nginx/sites-available/textstack.conf`:

```nginx
# textstack.dev -> Admin Panel (NOT public site)
server {
    listen 443 ssl http2;
    server_name textstack.dev;

    # Block indexing
    add_header X-Robots-Tag "noindex, nofollow" always;

    # Serve admin app
    location / {
        proxy_pass http://localhost:81;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    # Admin API
    location /admin/ {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    ssl_certificate /etc/letsencrypt/live/textstack.dev/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/textstack.dev/privkey.pem;
}

# textstack.app -> Public Site (unchanged)
server {
    listen 443 ssl http2;
    server_name textstack.app www.textstack.app;

    location / {
        proxy_pass http://localhost:5173;
        # ... existing config
    }

    location /api/ {
        proxy_pass http://localhost:8080;
        # ... existing config
    }
}
```

Test and reload:
```bash
sudo nginx -t
sudo systemctl reload nginx
```

### 3. Deploy Code

```bash
cd /path/to/onlinelib
git pull origin main

# Rebuild all containers
docker compose up -d --build
```

### 4. Run Migration

Migration will automatically run on container start (migrator service).

Verify:
```bash
# Check migration logs
docker compose logs migrator

# Verify books moved
docker compose exec db psql -U textstack_prod -d textstack_prod -c \
  "SELECT site_id, COUNT(*) FROM editions GROUP BY site_id;"
# Should show only general site ID (11111111-1111-1111-1111-111111111111)
```

### 5. Update DNS (if needed)

If textstack.dev was pointing to different server:
- Update A record for textstack.dev to point to same server as textstack.app

### 6. Verify

```bash
# Check X-Robots-Tag
curl -I https://textstack.dev

# Should see:
# X-Robots-Tag: noindex, nofollow

# Check admin panel loads
curl -s https://textstack.dev | grep -o '<title>.*</title>'
# Should see: <title>TextStack Admin</title>

# Check public site unchanged
curl -s https://textstack.app | grep -o '<title>.*</title>'
```

---

## Rollback Plan

### If migration fails:
```bash
# Restore database
make restore-prod FILE=backups/db_YYYYMMDD_HHMMSS.sql.gz

# Revert code
git checkout HEAD~1
docker compose up -d --build
```

### If nginx fails:
```bash
# Restore previous config
sudo cp /etc/nginx/sites-available/textstack.conf.backup /etc/nginx/sites-available/textstack.conf
sudo systemctl reload nginx
```

---

## Post-Deploy Checklist

- [ ] https://textstack.app works (public site)
- [ ] https://textstack.dev shows admin login
- [ ] Admin login works
- [ ] All admin tabs work (Dashboard, Upload, Jobs, Editions, Authors, Genres, Tools, SEO Crawl)
- [ ] Programming books visible on textstack.app
- [ ] `curl -I https://textstack.dev` shows X-Robots-Tag
- [ ] Google Search Console: request removal of textstack.dev pages

---

## Files Changed

| File | Change |
|------|--------|
| `apps/admin/src/api/client.ts` | Added `credentials: 'include'`, removed `getSites()` |
| `apps/admin/src/pages/SeoCrawlPage.tsx` | Use `DEFAULT_SITE_ID` |
| `apps/admin/src/pages/UploadPage.tsx` | Use `DEFAULT_SITE_ID` |
| `apps/admin/src/pages/ToolsPage.tsx` | NEW - sync/reprocess operations |
| `apps/admin/src/pages/SitesPage.tsx` | DELETED |
| `apps/admin/src/App.tsx` | Added Tools route, removed Sites |
| `apps/admin/src/components/Layout.tsx` | Added Tools nav, removed Sites |
| `backend/src/Api/Sites/HostSite*.cs` | DELETED |
| `backend/src/Api/Endpoints/AdminSitesEndpoints.cs` | DELETED |
| `backend/src/Api/Endpoints/DebugEndpoints.cs` | DELETED |
| `backend/src/Application/Sites/SiteService.cs` | DELETED |
| `backend/src/Infrastructure/Migrations/20260120...` | NEW - merge migration |
