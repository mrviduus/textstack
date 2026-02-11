# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Free book library w/ Kindle-like reader. Upload EPUB/PDF/FB2 → parse → SEO pages + offline-first sync.

**Live**: [textstack.app](https://textstack.app/) (public) · [textstack.dev](https://textstack.dev/) (admin)

**Stack**: ASP.NET Core (API + Worker) + PostgreSQL + React

**Prerequisites**: Docker, .NET 10 SDK, Node.js 18+, pnpm

**CI/CD**: Push to `main` → auto-deploy. SSG rebuild: admin panel or `make rebuild-ssg`.

## Commands

```bash
# Setup (one-time)
cp .env.example .env          # Edit with real values
make nginx-setup              # Install nginx config (Linux)
make nginx-setup-mac          # Mac
make up                       # Start services

# Docker
make up / down / restart / logs / status

# Deploy
make deploy                   # Full deploy (pull, build, restart, SSG)
make rebuild-ssg              # Rebuild SSG pages only

# Database
make backup                   # Backup to ~/backups/textstack/
make backup-list              # List all backups
make restore FILE=path.gz     # Restore from backup
docker compose exec db psql -U app books   # DB shell
docker compose down -v                      # Reset all (loses data)

# Tests
dotnet test                                 # All tests
dotnet test tests/TextStack.UnitTests
dotnet test tests/TextStack.IntegrationTests
dotnet test tests/TextStack.Extraction.Tests
dotnet test tests/TextStack.Search.Tests
dotnet test --filter "Name~TestMethodName"  # Single test
pnpm -C apps/web test                       # Frontend unit tests (Vitest)
pnpm -C apps/web test:watch                 # Watch mode
pnpm -C apps/web test:e2e                   # Playwright E2E (headless)
pnpm -C apps/web test:e2e:ui                # Playwright E2E (UI mode)

# Lint
dotnet format backend/TextStack.sln         # Backend
pnpm -C apps/web lint                       # Frontend

# Local dev (no Docker)
dotnet run --project backend/src/Api
dotnet run --project backend/src/Worker
pnpm -C apps/web dev          # http://localhost:5173
pnpm -C apps/admin dev        # http://localhost:81

# Build
pnpm -C apps/web build
pnpm -C apps/admin build

# Migrations
dotnet ef migrations add <Name> --project backend/src/Infrastructure --startup-project backend/src/Api
MIGRATE_TARGET=0 docker compose up migrator   # Rollback all migrations
```

| Service | Local | Prod |
|---------|-------|------|
| Web | http://localhost:5173 | https://textstack.app |
| API | http://localhost:8080 | https://textstack.app/api |
| API Docs | http://localhost:8080/scalar/v1 | — |
| Admin | http://localhost:81 | https://textstack.dev |
| Aspire | http://127.0.0.1:18888 | — |

**Storage**: Files at `./data/storage/books/{editionId}/` (originals + derived covers).

## Architecture

```
API → Application → Domain ← Infrastructure
                      ↑
                   Worker
```

- **Domain**: Pure C#, no framework deps
- **Application**: Business logic, interfaces (`IAppDbContext`, `IFileStorageService`)
- **Infrastructure**: EF Core (snake_case naming), storage implementations
- **API/Worker**: Orchestration, DI

**Middleware pipeline** (order matters): `ForwardedHeaders` → `Cors` → `ExceptionMiddleware` → `SiteContext` → `LanguageContext` → `AdminAuth`

**Multisite**: Every request → `SiteContextMiddleware` → Host → SiteId. Unknown host → 404. All queries scoped to SiteId. Dev mode: `?site=` query param override.

**Patterns**:
- Endpoints: `Map{Domain}Endpoints()` in `Api/Endpoints/`
- Test naming: `{Method}_{Scenario}_{Expected}`

### Frontend Architecture

**No Redux/Zustand** — React Context only. Provider hierarchy in `App.tsx`:
```
SiteProvider → AuthProvider → DownloadProvider → LanguageProvider → {children}
```

- **SiteProvider**: Fetches `/api/site/context`, provides `site` to all children
- **LanguageProvider**: Extracts `lang` from URL params, provides `switchLanguage()`, `getLocalizedPath()`
- **AuthProvider**: Google Sign-In, auto-refresh token, skips Google for bots

**i18n**: JSON files in `apps/web/src/locales/{en,uk}.json`. Hook: `useTranslation()`. Languages: `['en', 'uk']`.

**Routing**: Language-prefixed routes (`/:lang/books`, `/:lang/authors`, etc). Root `/` → `/en`.

**API client**: `useApi()` hook → `createApi(language)` → methods like `getBooks()`, `getBook(slug)`. Uses `fetchJsonWithRetry()`.

**Admin panel**: Separate React app (English-only, no i18n). JWT auth, sidebar layout.

## Key Concepts

**Entity Hierarchy**: Site → Work → Edition → Chapter
- Work = canonical book (just slug), Edition = per-language version with metadata
- Edition contains: title, description, cover_path, SEO fields
- Edition ↔ Author via EditionAuthor (M2M), Edition → Genre (FK)
- Chapter contains: html (rendered), plain_text (search), search_vector (FTS)

**Book Upload Flow**:
```
Upload EPUB/PDF/FB2 → BookFile (stored) → IngestionJob (queued)
     → Worker polls → Extraction → Chapters created → search_vector indexed
```

**SSG**: Puppeteer prerenders SEO pages to static HTML
- nginx serves SSG first, falls back to SPA
- Run `make rebuild-ssg` after content changes

**When to rebuild SSG**:
- After adding/publishing new books
- After updating book metadata
- After adding/updating authors or genres
- NOT needed for: reading progress, bookmarks, user data

## API Endpoints

**Public**: `GET /books`, `/books/{slug}`, `/authors`, `/genres`, `/search?q=`

**Auth**: `POST /auth/login`, `/auth/refresh`, `/auth/logout`

**User**: `GET/POST /me/library`, `/me/progress`, `/me/bookmarks`

**Admin**: `POST /admin/books/upload`, `GET /admin/ingestion/jobs`

## Key Files

| Area | Path |
|------|------|
| Domain | `backend/src/Domain/Entities/` |
| API | `backend/src/Api/Endpoints/` |
| Worker | `backend/src/Worker/Services/IngestionWorkerService.cs` |
| Extraction | `backend/src/Extraction/` (EPUB/PDF/FB2 parsers) |
| Search | `backend/src/Search/` |
| Web Pages | `apps/web/src/pages/` |
| Reader | `apps/web/src/pages/ReaderPage.tsx` |
| Library | `apps/web/src/pages/LibraryPage.tsx` |
| Admin | `apps/admin/src/pages/` |
| SSG | `apps/web/scripts/prerender.mjs` |
| nginx config | `infra/nginx/textstack.conf` |

## Search

Search uses raw SQL (Dapper). After schema changes:
1. Update `PostgresSearchProvider.cs` SQL
2. Run `dotnet test tests/TextStack.IntegrationTests --filter SearchEndpoint`
3. Test: `https://textstack.app/en/search?q=test`

## Test Projects

```
tests/
├── TextStack.UnitTests/           # Pure logic, no DB
├── TextStack.IntegrationTests/    # API + DB (Testcontainers)
├── TextStack.Extraction.Tests/    # Book parsing (EPUB/PDF/FB2)
├── TextStack.Search.Tests/        # Search logic
apps/web/e2e/                      # Playwright E2E (chromium, mobile, admin projects)
```

Test naming convention: `{MethodName}_{Scenario}_{ExpectedResult}`

**E2E setup**: Global setup authenticates test user + admin, discovers books from API → `.test-data.json`. Auth state stored in `apps/web/e2e/.auth/`. Page object helpers in `apps/web/e2e/helpers/`.

## Deployment

```
Internet → Cloudflare (DNS+SSL) → Cloudflare Tunnel → nginx (port 80)
  ├─ textstack.app → SSG static files + /api/ proxy to :8080
  └─ textstack.dev → admin panel (:81)
```

Docker services: `db` (postgres:16), `migrator`, `api`, `worker`, `admin`, `ssg-worker`, `aspire-dashboard`, `libretranslate`. All localhost-only, no public ports except 80 via tunnel.

## Verifying SSG

After content changes, verify SSG is serving correctly:
```bash
# Check header indicates SSG (not SPA fallback)
curl -I https://textstack.app/en/books/dracula/ | grep X-SEO-Render
# Expected: X-SEO-Render: ssg

# Check SPA routes still work
curl -I https://textstack.app/en/search | grep X-SEO-Render
# Expected: X-SEO-Render: spa
```
