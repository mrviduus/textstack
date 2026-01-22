# SSG Prerender Architecture

## Overview

Pre-renders SEO pages to static HTML at build time using Puppeteer. Google sees full HTML content without JavaScript execution.

## How It Works

```
1. pnpm build → Vite builds SPA to dist/
2. node scripts/prerender.mjs →
   - Fetches routes from /ssg/routes API
   - Starts local server with API proxy
   - Puppeteer renders each route
   - Saves HTML to dist/ssg/
3. nginx serves SSG HTML for SEO routes, SPA for others
```

## Architecture

```
nginx
  ├── /en/, /en/books, /en/books/:slug, etc.
  │     └── try SSG HTML first → fallback to SPA
  └── /en/read/*, /en/library, /en/search
        └── SPA directly
```

## Routes Prerendered (SSG)

| Route | Example |
|-------|---------|
| Homepage | `/en/`, `/uk/` |
| Book catalog | `/en/books`, `/uk/books` |
| Book detail | `/en/books/dracula` |
| Author detail | `/en/authors/bram-stoker` |
| Genre detail | `/en/genres/horror` |
| About | `/en/about`, `/uk/about` |

## Routes NOT Prerendered (SPA)

| Route | Reason |
|-------|--------|
| `/en/read/:book/:chapter` | Reader UI needs JS, noindex |
| `/en/library` | User-specific content |
| `/en/search` | Dynamic results |

## Build Commands

```bash
# Full build (SPA + SSG)
pnpm -C apps/web build:ssg

# SSG only (after SPA is built, requires API running)
cd apps/web && API_URL=http://localhost:8080 API_HOST=general.localhost node scripts/prerender.mjs

# Docker-based SSG build (dev)
docker compose --profile build up web-build

# Production rebuild
make rebuild-ssg
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `API_URL` | `http://localhost:8080` | API base URL |
| `API_HOST` | `general.localhost` | Host header for API requests |
| `CONCURRENCY` | `4` | Parallel Puppeteer tabs |

## Output Structure

```
apps/web/dist/
├── index.html          # SPA shell
├── assets/             # JS/CSS bundles
└── ssg/
    ├── en/
    │   ├── index.html              # Homepage
    │   ├── books/
    │   │   ├── index.html          # Catalog
    │   │   ├── dracula/index.html
    │   │   └── ...
    │   ├── authors/
    │   │   └── bram-stoker/index.html
    │   └── genres/
    │       └── horror/index.html
    └── uk/
        └── ...
```

## nginx Routing

SSG routes use `try_files` to check for pre-rendered HTML first:

```nginx
location ~ ^/(en|uk)/books/[^/]+/?$ {
    add_header X-SEO-Render "ssg" always;
    try_files /ssg$uri/index.html @spa;
}

location @spa {
    add_header X-SEO-Render "spa" always;
    try_files $uri /index.html;
}
```

## X-SEO-Render Header

Response header indicates which version was served:
- `ssg` — pre-rendered HTML
- `spa` — SPA fallback

Test: `curl -I https://textstack.app/en/books/dracula/ | grep X-SEO-Render`

## API Endpoints

Used by prerender script at build time:

| Endpoint | Purpose |
|----------|---------|
| `GET /ssg/routes` | All routes to prerender |
| `GET /ssg/books` | Book slugs + languages |
| `GET /ssg/authors` | Author slugs |
| `GET /ssg/genres` | Genre slugs |

## Key Files

| File | Purpose |
|------|---------|
| `apps/web/scripts/prerender.mjs` | Puppeteer prerender script |
| `apps/web/Dockerfile.ssg` | Docker image with Chromium |
| `backend/src/Api/Endpoints/SsgEndpoints.cs` | SSG API endpoints |
| `infra/nginx/nginx.conf` | Dev nginx with SSG routing |
| `infra/nginx-prod/textstack.conf` | Prod nginx with SSG routing |

## When to Rebuild SSG

Rebuild after:
- New books published
- Book/author/genre metadata changed
- SEO template changes
- Frontend changes affecting SEO pages

Command: `make rebuild-ssg`

## Verification

```bash
# Check SSG served
curl -I https://textstack.app/en/books/dracula/ | grep X-SEO-Render
# Expected: X-SEO-Render: ssg

# Check SPA fallback
curl -I https://textstack.app/en/search | grep X-SEO-Render
# Expected: X-SEO-Render: spa

# Check SEO content
curl -s https://textstack.app/en/books/dracula/ | grep '<title>'
# Expected: <title>Dracula — read online | TextStack</title>
```
