# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Free book library w/ Kindle-like reader. Upload EPUB/PDF/FB2 → parse → SEO pages + offline-first sync.

**Live**: [textstack.app](https://textstack.app/) (public) · [textstack.dev](https://textstack.dev/) (admin)

**Stack**: ASP.NET Core (API + Worker) + PostgreSQL + React

**CI/CD**: Push to `main` → auto-deploy. SSG rebuild: admin panel or `make rebuild-ssg`.

## Quick Start

```bash
# Setup (one-time)
cp .env.example .env                          # Edit with real values
make nginx-setup                              # Install nginx config
make up                                       # Start services

# Daily
make status                 # Check health
make logs                   # View logs
make deploy                 # Pull + build + restart
make rebuild-ssg            # Regenerate SEO pages
make backup                 # Backup database
```

## Commands

```bash
# Docker
make up                     # Start services
make down                   # Stop services
make restart                # Restart services
make logs                   # Tail logs
make status                 # Health check

# Deploy
make deploy                 # Full deploy (pull, build, restart, SSG)
make rebuild-ssg            # Rebuild SSG pages only

# Database
make backup                 # Backup to backups/
make restore FILE=path.gz   # Restore from backup
make backup-list            # List backups

# Setup
make nginx-setup            # Install nginx config (one-time)

# Tests
dotnet test                 # All tests
dotnet test tests/TextStack.UnitTests
dotnet test tests/TextStack.IntegrationTests
dotnet test --filter "FullyQualifiedName~TestMethodName"  # Single test

# Local dev (no Docker)
dotnet run --project backend/src/Api

# Frontend
pnpm -C apps/web build
pnpm -C apps/admin build

# Migrations
dotnet ef migrations add <Name> --project backend/src/Infrastructure --startup-project backend/src/Api
```

| Service | URL |
|---------|-----|
| Web | https://textstack.app |
| API | https://textstack.app/api |
| Admin | https://textstack.dev |
| Aspire | http://127.0.0.1:18888 |

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
| Search | `backend/src/Search/` |
| Web Pages | `apps/web/src/pages/` |
| Reader | `apps/web/src/pages/ReaderPage.tsx` |
| Library | `apps/web/src/pages/LibraryPage.tsx` |
| Admin | `apps/admin/src/pages/` |
| SSG | `apps/web/scripts/prerender.mjs` |

## Search

Search uses raw SQL (Dapper). After schema changes:
1. Update `PostgresSearchProvider.cs` SQL
2. Run `dotnet test tests/TextStack.IntegrationTests --filter SearchEndpoint`
3. Test: `https://textstack.app/en/search?q=test`
