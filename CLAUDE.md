# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Free book library w/ Kindle-like reader. Upload EPUB/PDF/FB2 → parse → SEO pages + offline-first sync.

**Live**: [textstack.app](https://textstack.app/) (general) · [textstack.dev](https://textstack.dev/) (programming)

**Stack**: ASP.NET Core (API + Worker) + PostgreSQL + React + Multisite

## Commands

```bash
# Full stack
docker compose up --build

# Backend only
dotnet run --project backend/src/Api
dotnet run --project backend/src/Worker

# Frontend
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

# Database backup/restore
make backup                 # Create compressed backup
make restore FILE=backups/db_xxx.sql.gz  # Restore
```

| Service | URL |
|---------|-----|
| API | http://localhost:8080 |
| API Docs | http://localhost:8080/scalar/v1 |
| Web | http://localhost:5173 |
| Admin | http://localhost:5174 |
| Postgres | localhost:5432 |
| Grafana | http://localhost:3000 |
| Prometheus | http://localhost:9090 |

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

**Multisite**: Host header → SiteResolver → SiteContext
- Dev override: `?site=general` or `?site=programming`
- Test: `http://localhost:5173/?site=general`
- Files: `backend/src/Api/Sites/`

**Storage**:
- Files: `./data/storage/books/{editionId}/original/` (bind mount)
- DB: `book_files.storage_path` = relative path only
- Content: `chapters.html` + `chapters.plain_text` after parsing

**Search**: PostgreSQL FTS + pg_trgm
- `chapters.search_vector` (tsvector) for full-text
- GIN indexes for fast queries
- Fuzzy search via trigrams

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

**Admin**:
- `POST /admin/books/upload` — create Work + Edition + BookFile + IngestionJob
- `GET /admin/ingestion/jobs` — list jobs
- CRUD: `/admin/authors`, `/admin/sites`

## Key Files

| Area | Path |
|------|------|
| Domain | `backend/src/Domain/Entities/{Work,Edition,Chapter,Author,Genre}.cs` |
| API | `backend/src/Api/Endpoints/{Books,Authors,Genres,Search,Seo}Endpoints.cs` |
| Services | `backend/src/Application/{Books,Ingestion,Seo}/` |
| Worker | `backend/src/Worker/Services/IngestionWorkerService.cs` |
| Search | `backend/src/Search/` |
| Extraction | `backend/src/Extraction/OnlineLib.Extraction/` |
| Web | `apps/web/src/pages/` |
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

- 3 site resolution sources (HostSiteResolver, SiteResolver, frontend SiteContext) - needs consolidation
- User entity features (ReadingProgresses, Bookmarks, Notes) unused in API
- AdminAuditLog entity defined but never used
