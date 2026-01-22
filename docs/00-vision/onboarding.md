# Developer Onboarding Guide

Welcome to TextStack! This guide gets you productive fast.

## First Day Checklist

- [ ] Clone repo: `git clone <repo-url>`
- [ ] Read `README.md` - project overview
- [ ] Read `CLAUDE.md` - codebase guide (important!)
- [ ] Start dev env: `docker compose up --build`
- [ ] Verify services running:
  - http://localhost:5173 (web)
  - http://localhost:8080/scalar/v1 (API docs)
- [ ] Run tests: `dotnet test`

## Architecture Overview

```
┌─────────────┐     ┌─────────────┐
│   Web App   │────▶│    API      │
│  (React)    │     │ (ASP.NET)   │
└─────────────┘     └──────┬──────┘
                          │
      ┌───────────────────┼───────────────────┐
      │                   │                   │
      ▼                   ▼                   ▼
┌──────────┐       ┌──────────┐       ┌──────────┐
│ Postgres │       │  Worker  │       │ Storage  │
│   (FTS)  │       │(Ingestion│       │ (Files)  │
└──────────┘       └──────────┘       └──────────┘
```

### Key Concepts

1. **Work/Edition Model**: Work = canonical book, Edition = per-language version
2. **Site Scoping**: Content isolated per site (general, programming)
3. **Reader**: Kindle-like with offline support
4. **Ingestion**: EPUB/PDF → parsed chapters → searchable

## Codebase Map

| Area | Path | Start Here |
|------|------|------------|
| API endpoints | `backend/src/Api/Endpoints/` | `BooksEndpoints.cs` |
| Domain entities | `backend/src/Domain/Entities/` | `Edition.cs` |
| Services | `backend/src/Application/` | `BookService.cs` |
| Web pages | `apps/web/src/pages/` | `HomePage.tsx` |
| Reader | `apps/web/src/pages/` | `ReaderPage.tsx` |

## Good First Issues

Start with these:
- Documentation improvements
- Add missing test coverage
- UI polish/fixes
- Small bug fixes

Look for `good-first-issue` label.

## Development Workflow

1. **Pick an issue** or discuss new work
2. **Create branch**: `feat/short-description`
3. **Work in small slices** - each PR independently mergeable
4. **Test**: `dotnet test` must pass
5. **Create PR** with clear description
6. **Address review** feedback
7. **Merge** after approval

## Key Files to Understand

| File | Why |
|------|-----|
| `CLAUDE.md` | Codebase guidance, patterns |
| `docs/01-architecture/README.md` | System design |
| `docs/02-system/database.md` | DB schema |
| `docs/04-dev/testing.md` | Testing strategy |

## Common Tasks

### Add API Endpoint
1. Add method in `backend/src/Api/Endpoints/`
2. Add DTO in `backend/src/Contracts/`
3. Add service method if needed
4. Add integration test

### Add Web Page
1. Create `apps/web/src/pages/NewPage.tsx`
2. Add route in `App.tsx`
3. Add API client if needed

### Run Specific Tests
```bash
dotnet test --filter "Name~YourTest"
```

## Getting Help

- Check `docs/` folder first
- Search existing code for patterns
- Ask in PR comments or issues

## Tech Stack Quick Reference

| Layer | Tech |
|-------|------|
| API | ASP.NET Core Minimal APIs |
| DB | PostgreSQL + EF Core |
| Search | PostgreSQL FTS (tsvector) |
| Web | React + Vite + TypeScript |
| Worker | ASP.NET Background Service |

## Next Steps

After setup:
1. Browse the web app, try the reader
2. Look at `BooksEndpoints.cs` to understand API pattern
3. Look at `BookService.cs` for service pattern
4. Pick a `good-first-issue` and start contributing!
