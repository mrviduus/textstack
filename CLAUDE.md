# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Free book library w/ Kindle-like reader. Upload EPUB/PDF/FB2 → parse → SEO pages + offline-first sync.

**Live**: [textstack.app](https://textstack.app/) (public) · [textstack.dev](https://textstack.dev/) (admin)

**Stack**: ASP.NET Core (API + Worker) + PostgreSQL + React

## CRITICAL: Production Environment

**This server runs PRODUCTION with real user data (~1400 books, 39k chapters). Data loss is unacceptable.**

### Dev vs Prod - DO NOT CONFUSE

| | Dev | Prod |
|--|-----|------|
| Compose file | `docker-compose.yml` | `docker-compose.prod.yml` |
| DB container | `books_db` | `textstack_db_prod` |
| DB volume | `data/postgres` (64MB) | `data/postgres-prod` (2.4GB) |
| DB name | `books` | `textstack_prod` |
| DB user | `app` | `textstack_prod` |

### Rules

1. **ALWAYS use prod compose:**
   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.production up -d
   ```

2. **NEVER run `docker compose up` without `-f docker-compose.prod.yml`** - this starts dev with empty database!

3. **Backup prod (not dev):**
   ```bash
   make backup-prod    # Correct - backs up textstack_db_prod
   make backup         # WRONG - backs up empty dev database
   ```

4. **Before any docker/db operation:** verify you're targeting prod containers (`textstack_*_prod`)

5. **When in doubt:** check `docker ps` - prod containers have `textstack_*_prod` names

## Commands

### Production (THIS SERVER)

```bash
# Start/restart prod
docker compose -f docker-compose.prod.yml --env-file .env.production up -d

# Rebuild and restart prod
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build

# Full deploy (pull, build frontend, restart)
make deploy

# Quick restart (no rebuild)
make deploy-quick

# Status/logs/restart
make prod-status
make prod-logs
make prod-restart

# Backup prod database
make backup-prod
```

### Development (local machine only)

```bash
# Full stack
docker compose up --build

# Rebuild specific service
docker compose up --build -d web
docker compose up --build -d api

# Frontend only (if needed outside Docker)
pnpm -C apps/web dev
pnpm -C apps/admin dev

# Tests
dotnet test                                             # All tests
dotnet test tests/OnlineLib.UnitTests                   # Unit tests
dotnet test tests/OnlineLib.IntegrationTests            # Integration tests
dotnet test tests/OnlineLib.Extraction.Tests            # Extraction tests
dotnet test tests/OnlineLib.Search.Tests                # Search tests
dotnet test --filter "FullyQualifiedName~ClassName"     # Single class
dotnet test --filter "Name~TestMethodName"              # Single method

# Type-check frontend
pnpm -C apps/web build    # includes tsc
pnpm -C apps/admin build  # includes tsc

# Migrations
dotnet ef migrations add <Name> --project backend/src/Infrastructure --startup-project backend/src/Api

# Docker helpers
./scripts/docker-clean.sh    # Stop + remove project images/volumes
./scripts/docker-build.sh    # Fresh build + start
./scripts/docker-nuke.sh     # NUCLEAR: removes ALL docker data system-wide

# Database backup/restore (DEV ONLY - see Production section for prod)
make backup                 # Backup dev database
make restore FILE=backups/db_xxx.sql.gz  # Restore to dev
```

| Service | URL |
|---------|-----|
| API | http://localhost:8080 |
| API Docs | http://localhost:8080/scalar/v1 |
| Web | http://localhost:5173 |
| Admin | http://localhost:5174 |
| Postgres | localhost:5432 |
| Aspire Dashboard | http://localhost:18888 |

## Key Concepts

**Entity Hierarchy**: Site → Work → Edition → Chapter
- Work = canonical book (just slug), Edition = per-language version with metadata
- Edition contains: title, description, cover_path, SEO fields
- Edition ↔ Author via EditionAuthor (M2M), Edition → Genre (FK)
- Chapter contains: html (rendered), plain_text (search), search_vector (FTS)
- Author/Genre are site-scoped with SEO fields
- site_id scopes content; User is global

**Book Upload Flow**:
```
Upload EPUB/PDF/FB2 → BookFile (stored) → IngestionJob (queued)
     → Worker polls → Extraction → Chapters created → search_vector indexed
```

**Site Context**: Host header → SiteResolver → SiteContext
- Files: `backend/src/Api/Sites/`

**Storage**:
- Files: `./data/storage/books/{editionId}/original/` (bind mount)
- DB: `book_files.storage_path` = relative path only
- Content: `chapters.html` + `chapters.plain_text` after parsing

**Search**: PostgreSQL FTS + pg_trgm
- `chapters.search_vector` (tsvector) for full-text
- GIN indexes for fast queries
- Fuzzy search via trigrams

**Reader**: Kindle-like reading experience
- Page-based pagination with smooth transitions
- Settings: font size, line height, width, theme, font family
- Fullscreen mode with auto-hiding bars
- Keyboard shortcuts (arrows, F, ?)
- Mobile: swipe navigation, tap zones, immersive mode
- Auto-save progress (local + server sync)

**Offline Reading**: PWA with IndexedDB
- Cache-first chapter loading
- Download manager with progress tracking
- Resume support for interrupted downloads
- Storage quota checks (50MB minimum)
- UI: offline badge, download/resume/remove menu

**User Auth**: Google OAuth
- Cookie-based JWT with refresh tokens
- User library (save/unsave books)
- Reading progress sync to server
- Continue reading from library page

## API Endpoints

**Public**:
- `GET /books` — list editions (paginated, ?language=)
- `GET /books/{slug}` — edition detail + chapters + other editions
- `GET /books/{slug}/chapters/{chapterSlug}` — chapter HTML + prev/next
- `GET /authors`, `GET /authors/{slug}` — author listing + detail
- `GET /genres`, `GET /genres/{slug}` — genre listing + detail
- `GET /search?q=` — full-text search
- `GET /seo/sitemap.xml` — dynamic sitemap
- `GET /health` — health check

**Auth**:
- `POST /auth/login` — Google OAuth login
- `POST /auth/refresh` — JWT refresh
- `POST /auth/logout`

**User** (authenticated):
- `GET /me/library` — list saved books
- `POST /me/library` — save book
- `DELETE /me/library/{editionId}` — unsave
- `GET /me/progress` — get all reading progress
- `POST /me/progress` — save reading position
- `GET /me/bookmarks` — list bookmarks
- `POST /me/bookmarks` — create bookmark
- `DELETE /me/bookmarks/{id}` — delete bookmark

**Admin**:
- `POST /admin/books/upload` — create Work + Edition + BookFile + IngestionJob
- `GET /admin/ingestion/jobs` — list jobs
- CRUD: `/admin/authors`, `/admin/sites`

## Key Files

| Area | Path |
|------|------|
| Domain | `backend/src/Domain/Entities/{Work,Edition,Chapter,Author,Genre}.cs` |
| API | `backend/src/Api/Endpoints/{Books,Authors,Genres,Search,Seo}Endpoints.cs` |
| User API | `backend/src/Api/Endpoints/UserDataEndpoints.cs` |
| Auth API | `backend/src/Api/Endpoints/AuthEndpoints.cs` |
| Services | `backend/src/Application/{Books,Ingestion,Seo}/` |
| Worker | `backend/src/Worker/Services/IngestionWorkerService.cs` |
| Search | `backend/src/Search/` |
| Extraction | `backend/src/Extraction/OnlineLib.Extraction/` |
| Multisite | `backend/src/Api/Sites/{SiteContextMiddleware,SiteResolver}.cs` |
| Web Pages | `apps/web/src/pages/` |
| Reader | `apps/web/src/pages/ReaderPage.tsx` |
| Library | `apps/web/src/pages/LibraryPage.tsx` |
| Offline DB | `apps/web/src/lib/offlineDb.ts` |
| Download | `apps/web/src/context/DownloadContext.tsx` |
| Auth Context | `apps/web/src/context/AuthContext.tsx` |
| Admin | `apps/admin/src/pages/` |

## IMPORTANT — HOW TO WORK IN THIS REPO

- Work strictly in **small slices**.
- Each slice must be **independently mergeable**.
- Follow **PDD + TDD**: tests first (RED), then code (GREEN), then refactor.
- **Do not expand scope** beyond the given slice.
- If extra work is discovered, list it under **Follow-ups**, do NOT implement it.
- `dotnet test` must pass for every slice.
- Report results: Summary / Files / Tests / Manual / Follow-ups format.

## Critical: Search Reliability

Search is a **key feature** - must always work. React immediately to any search issues.

**Rules**:
1. **Schema changes** → update `PostgresSearchProvider.cs` SQL (both `countSql` AND `searchSql`)
2. Run `dotnet test tests/OnlineLib.IntegrationTests --filter SearchEndpoint` after any DB schema change
3. Test in browser: `http://general.localhost/en/search?q=test`
4. API 500 on search = **P0 bug**, fix immediately

**Common issues**:
- `column X does not exist` → SQL references old column, update to match current schema
- Search uses raw SQL (Dapper), not EF - schema changes don't auto-update

**Key files**:
- `backend/src/Search/OnlineLib.Search/Providers/PostgresFts/PostgresSearchProvider.cs` - raw SQL queries
- `tests/OnlineLib.IntegrationTests/SearchEndpointTests.cs` - catches schema mismatches

## Known Technical Debt

- Notes feature partially implemented (entity exists, API not fully wired) - see TODO in `Domain/Entities/Note.cs`
- No Service Worker for true offline PWA
- No background sync for offline operations
