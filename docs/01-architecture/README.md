# System Architecture

Modular monolith: single API + Worker, layered architecture, PostgreSQL.

## High-Level View

```
┌─────────────────────────────────────────────────────────┐
│                    Reverse Proxy                        │
│              (nginx/caddy, TLS termination)             │
└─────────────────────────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│     Web       │   │     API       │   │    Admin      │
│  (React/Vite) │   │ (ASP.NET Core)│   │  (React/Vite) │
│  port 5173    │   │  port 8080    │   │  port 5174    │
└───────────────┘   └───────────────┘   └───────────────┘
                            │
                    ┌───────┴───────┐
                    ▼               ▼
            ┌───────────────┐ ┌───────────────┐
            │    Worker     │ │   PostgreSQL  │
            │ (ingestion)   │ │   port 5432   │
            └───────────────┘ └───────────────┘
                    │               │
                    ▼               │
            ┌───────────────┐       │
            │   Storage     │◄──────┘
            │ (bind mount)  │
            └───────────────┘
```

## Backend Layers

```
backend/src/
├── Api/              # HTTP endpoints, middleware
│   ├── Endpoints/    # Minimal API route groups
│   ├── Sites/        # SiteResolver, SiteContext
│   └── Middleware/   # Exception handling
├── Application/      # Business logic
│   ├── Books/        # BookService
│   ├── Admin/        # AdminService
│   ├── Ingestion/    # IngestionService
│   ├── Search/       # SearchService
│   └── Sites/        # SiteService
├── Domain/           # Entities, enums (no dependencies)
│   ├── Entities/     # Work, Edition, Chapter, etc.
│   └── Enums/        # EditionStatus, JobStatus
├── Infrastructure/   # EF Core, storage
│   ├── Data/         # AppDbContext, Configurations
│   ├── Migrations/   # EF migrations
│   └── Storage/      # LocalFileStorageService
├── Worker/           # Background jobs
│   ├── Services/     # IngestionWorker
│   └── Parsers/      # EpubParser
└── Contracts/        # DTOs
```

## Dependency Rules

```
API ──► Application ──► Domain ◄── Infrastructure
                           ▲
                           │
                        Worker
```

- **Domain**: Pure C#, no framework dependencies
- **Application**: Business logic, depends on Domain + interfaces
- **Infrastructure**: Implements interfaces (IAppDbContext, IFileStorageService)
- **API/Worker**: Orchestration, DI configuration

## Key Patterns

### Minimal API
Endpoints grouped by domain:
- `MapBooksEndpoints()` — public book/chapter routes
- `MapAdminEndpoints()` — admin CRUD
- `MapSearchEndpoints()` — FTS search

### Background Jobs
Worker polls database for queued jobs:
```
IngestionJob.Status == Queued
  → Processing → Succeeded/Failed
```

### Site Context
Every request:
1. SiteContextMiddleware resolves Host → SiteContext
2. SiteContext.SiteId used in all queries
3. Unknown host → 404

## Frontend Structure

```
apps/
├── web/              # Public reader
│   ├── src/
│   │   ├── pages/
│   │   ├── components/
│   │   └── context/  # SiteContext.tsx
│   └── Dockerfile
├── admin/            # Admin panel
└── mobile/           # React Native (later)

packages/             # Shared TS code
├── api-client/       # Generated from OpenAPI
├── sync/             # Offline queue
└── reader/           # Locator format
```

## See Also

- [Multisite](multisite.md) — Host resolution and data isolation
- [ADR-006: Modular Monolith](adr/006-modular-monolith.md)
- [Frontend](frontend.md) — Monorepo structure
