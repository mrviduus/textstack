# feat-0007: Next.js SSG Migration — Product Design Document (PDD)

## 1. Purpose

Migrate web frontend from Vite SPA to Next.js Static Site Generation (SSG) for SEO.

**Problem**: Current SPA renders empty HTML:
```html
<div id="root"></div>
<script src="/assets/main.js"></script>
```
Google sees empty page → poor indexing.

**Solution**: Pre-render all pages at build time → full HTML served to crawlers.

---

## 2. Non-Goals

- No Server-Side Rendering (SSR) — static export only
- No Vercel deployment — self-hosted on existing infrastructure
- No admin panel migration — remains Vite SPA
- No real-time ISR — manual rebuild on publish

---

## 3. Architecture

### Current (SPA)
```
nginx ─┬─> web (5173)     # Vite dev server / static build
       ├─> api (8080)     # ASP.NET Core
       └─> admin (81)   # React Admin
```

### Target (SSG)
```
nginx ─┬─> /out/          # Pre-built static HTML (no container)
       ├─> api (8080)     # ASP.NET Core
       └─> admin (81)   # React Admin

Build (ephemeral):
  next-build → generates /out/ → exits
```

**Key change**: No runtime Node.js container. nginx serves static files directly.

---

## 4. Technical Requirements

### 4.1 Next.js Configuration
```typescript
// next.config.ts
export default {
  output: 'export',              // Static HTML export
  trailingSlash: true,           // /books/slug/ not /books/slug
  images: { unoptimized: true }, // No runtime optimization
}
```

### 4.2 Page Routes
```
apps/web-next/app/
├── [lang]/
│   ├── page.tsx                    # HomePage
│   ├── books/[slug]/
│   │   ├── page.tsx                # BookDetailPage
│   │   └── [chapter]/page.tsx      # ReaderPage
│   ├── authors/[slug]/page.tsx     # AuthorDetailPage
│   └── genres/[slug]/page.tsx      # GenreDetailPage
├── layout.tsx
└── globals.css
```

### 4.3 Static Params Generation
```typescript
// app/[lang]/books/[slug]/page.tsx
export async function generateStaticParams() {
  const books = await fetch(`${API}/ssg/books`).then(r => r.json())
  return books.map(b => ({ lang: b.language, slug: b.slug }))
}
```

### 4.4 Server vs Client Components
| Component | Type | Reason |
|-----------|------|--------|
| BookDetail | Server | HTML content |
| ReaderContent | Server | Chapter HTML |
| ReaderControls | Client | Pagination state |
| ReaderSettings | Client | User preferences |
| SearchInput | Client | Live search |
| ThemeSwitcher | Client | LocalStorage |

---

## 5. API Requirements

### 5.1 Bulk SSG Endpoints
New endpoints for build-time data fetching:

```
GET /ssg/books          # All published books (slug + lang)
GET /ssg/chapters/{slug} # All chapters for book
GET /ssg/authors        # All author slugs
GET /ssg/genres         # All genre slugs
```

- No pagination
- Minimal fields (slug only)
- Protected by API key
- Response <1s for ~500 items

### 5.2 Endpoint Schema
```csharp
// SsgEndpoints.cs
record SsgBookDto(string Slug, string Language);
record SsgChapterDto(string Slug);
```

---

## 6. Docker Integration

### 6.1 Build Container
```yaml
# docker-compose.yml
services:
  web-build:
    build: ./apps/web-next
    command: pnpm build
    volumes:
      - static-web:/app/out
    profiles: [build]

volumes:
  static-web:
```

### 6.2 Dockerfile
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install
COPY . .
RUN pnpm build
```

### 6.3 nginx Configuration
```nginx
server {
    listen 80;
    server_name textstack.app;

    location / {
        root /var/www/static;
        try_files $uri $uri/index.html =404;
    }

    location /api/ {
        proxy_pass http://api:8080/;
    }
}
```

### 6.4 Build Command
```bash
docker compose --profile build run --rm web-build
```

---

## 7. Rebuild Strategy

### On Content Change
```
Admin: Publish book
  → API: POST /admin/books/{id}/publish
  → API: Trigger rebuild
  → Build: docker compose --profile build run web-build
  → nginx: Serves updated files
```

### Full Rebuild
```bash
docker compose --profile build run --rm web-build
```

---

## 8. Work Slices

### Slice 3.1 — Next.js Project Setup
- Create `apps/web-next/`
- Configure `next.config.ts` for static export
- Verify `pnpm build` produces `/out/`

### Slice 3.2 — Bulk API Endpoints
- Add `SsgEndpoints.cs`
- Return all books/authors/genres slugs
- Test: `curl /ssg/books | jq length`

### Slice 3.3 — Core Pages Migration
- HomePage, BookDetailPage, ReaderPage
- AuthorDetailPage, GenreDetailPage
- `generateStaticParams()` for each

### Slice 3.4 — Client Components
- Reader controls (pagination, settings)
- Search input
- Theme switcher

### Slice 3.5 — Styles Migration
- Copy CSS from `apps/web/src/styles/`
- Adapt for CSS Modules if needed

### Slice 3.6 — Docker Build Integration
- Add `web-build` service
- Configure volume mount
- Test: `docker compose --profile build run web-build`

### Slice 3.7 — nginx Static Serving
- Update nginx config
- Mount static-web volume
- Test: `curl localhost | grep '<title>'`

### Slice 3.8 — Rebuild Automation
- Add webhook endpoint
- Trigger build on publish
- Test: Publish book → verify HTML updated

### Slice 3.9 — Cleanup
- Remove `apps/web/`
- Update docker-compose
- Remove `web` service

---

## 9. Test Plan

### Build Tests
```bash
# Static export succeeds
pnpm -C apps/web-next build
ls apps/web-next/out/en/books/*/index.html | wc -l

# All pages generated
find apps/web-next/out -name "index.html" | wc -l
```

### Integration Tests
```bash
# SSG API returns all books
curl localhost:8080/ssg/books | jq length

# nginx serves pre-rendered HTML
curl -s localhost/en/books/test-book/ | grep -o '<article>.*</article>' | head -c 100
```

### SEO Validation
- View page source → full HTML content visible
- Lighthouse SEO score ≥90
- Google Search Console → submit sitemap → verify indexing

---

## 10. Acceptance Criteria

Migration complete when:
- [ ] All public pages pre-rendered as static HTML
- [ ] No Node.js runtime container for web
- [ ] nginx serves static files directly
- [ ] Rebuild triggered on book publish
- [ ] Google can index page content
- [ ] Lighthouse SEO score ≥90
- [ ] `apps/web/` (Vite) deleted

---

## 11. Critical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Export mode | Static (no Node) | Simplest deployment |
| Rebuild trigger | On-publish webhook | Real-time updates |
| Image optimization | Disabled | Static export limitation |
| CSS approach | Global CSS | Migrate existing styles |
| ISR | Manual | No Vercel, self-hosted |

---

## 12. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Build time grows with content | Slow deploys | Incremental builds (future) |
| Client JS hydration issues | Broken interactivity | Thorough testing |
| Large static folder | Disk usage | Monitor, cleanup old builds |
| API rate limits during build | Build fails | Internal API, no limits |

---

## 13. Timeline

| Slice | Est. |
|-------|------|
| 3.1 Project Setup | 0.5d |
| 3.2 Bulk API | 0.5d |
| 3.3 Pages Migration | 2-3d |
| 3.4 Client Components | 1-2d |
| 3.5 Styles | 0.5d |
| 3.6 Docker | 0.5d |
| 3.7 nginx | 0.5d |
| 3.8 Rebuild | 0.5d |
| 3.9 Cleanup | 0.5d |

**Total: ~7-9 days**
