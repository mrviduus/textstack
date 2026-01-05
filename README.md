# OnlineLib

Free book library w/ Kindle-like reader. Upload EPUB/PDF/FB2 → parse → SEO pages + offline-first reading sync.

**Live**: [textstack.app](https://textstack.app/) (general) · [textstack.dev](https://textstack.dev/) (programming)

**Multisite**: Single backend serves multiple branded sites (general, programming, etc.) with shared content isolation.

## Quick Start

```bash
docker compose up --build
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

### Testing Sites

```
http://localhost:5173/?site=general      # General theme (default)
http://localhost:5173/?site=programming  # CodeBooks theme
```

In production, sites resolve via Host header (general.example.com, programming.example.com).

---

## Table of Contents

1. [Stack](#stack)
2. [Project Structure](#project-structure)
3. [Development](#development)
4. [Storage](#storage)
5. [Multisite Architecture](#multisite-architecture)
6. [Documentation](#documentation)
   - [Vision & Goals](#00-vision--goals)
   - [Architecture](#01-architecture)
   - [System Specs](#02-system-specs)
   - [Operations](#03-operations)
   - [Development Guides](#04-development-guides)
   - [ADRs](#architectural-decision-records-adrs)

---

## Stack

- **Backend**: ASP.NET Core (API + Worker) + PostgreSQL + EF Core
- **Frontend**: React (web), React Native Expo (mobile, later)
- **Search**: PostgreSQL FTS (tsvector + GIN)
- **Multisite**: Host-based resolution, per-site theming, content isolation

## Project Structure

```
├── backend/
│   ├── src/Api/           # Minimal API, auth, SEO HTML
│   │   └── Sites/         # Multisite: SiteResolver, middleware
│   ├── src/Worker/        # Book ingestion pipeline
│   ├── src/Infrastructure/# DbContext, migrations, storage
│   ├── src/Domain/        # Entities, value objects
│   └── src/Contracts/     # DTOs
├── apps/
│   ├── web/               # React (Vite) - public site
│   ├── admin/             # React (Vite) - admin panel
│   └── mobile/            # React Native Expo (later)
├── packages/              # Shared TS code
├── scripts/               # Docker clean/build scripts
└── docs/                  # Architecture docs
```

## Development

### Docker Scripts

```bash
./scripts/docker-clean.sh   # Stop + remove project images/volumes
./scripts/docker-build.sh   # Fresh build + start all services
./scripts/docker-nuke.sh    # NUCLEAR: removes ALL docker data system-wide
```

### Database Backup & Restore

```bash
make backup                 # Create compressed backup
make backup-list            # List available backups
make restore FILE=backups/db_2024-01-15_143022.sql.gz  # Restore from backup
```

Config via env vars: `POSTGRES_CONTAINER`, `POSTGRES_USER`, `POSTGRES_DB`, `BACKUP_KEEP` (default: 7).

See [scripts/restore_postgres.md](scripts/restore_postgres.md) for full restore docs.

### Migrations

Migrations run automatically via dedicated Docker service before api/worker start.

```bash
# Apply all pending (default)
docker compose up

# Rollback to specific migration
MIGRATE_TARGET=Initial_Content docker compose up migrator

# Create new migration
dotnet ef migrations add <Name> \
  --project backend/src/Infrastructure \
  --startup-project backend/src/Api
```

### Local Dev (without Docker)

```bash
# Backend
dotnet run --project backend/src/Api

# Worker
dotnet run --project backend/src/Worker

# Web
pnpm -C apps/web dev
```

## Storage

Files on host at `./data/storage`:
```
./data/storage/books/{bookId}/original/{assetId}.epub
./data/storage/books/{bookId}/derived/cover.jpg
```

DB stores paths only. Containers mount via bind mount.

## Multisite Architecture

Sites resolve via Host header → SiteResolver → SiteContext per request.

| Entity | Scoping |
|--------|---------|
| Work | site_id (primary) |
| Edition | site_id (denormalized) |
| ReadingProgress, Bookmark, Note | site_id |
| User | Global (cross-site account) |

Key files:
- `backend/src/Api/Sites/` - SiteResolver, SiteContextMiddleware
- `apps/web/src/context/SiteContext.tsx` - frontend site context
- `apps/web/src/config/sites.ts` - per-site theming

---

## Documentation

### Reading Order

| Audience | Path |
|----------|------|
| New to project | Vision → Architecture → Local Dev |
| Backend work | Database → API → Ingestion |
| Frontend work | Architecture → Multisite → Reader |
| Ops | Local Dev → Backup |

---

### 00 Vision & Goals

| Document | Description |
|----------|-------------|
| [Vision](docs/00-vision/README.md) | Project goals, principles, target users |
| [Roadmap](docs/00-vision/roadmap.md) | MVP phases, feature checklists |

---

### 01 Architecture

| Document | Description |
|----------|-------------|
| [Architecture Overview](docs/01-architecture/README.md) | System design, layers, data flow |
| [Frontend Architecture](docs/01-architecture/frontend.md) | React structure, state, routing |
| [Multisite Design](docs/01-architecture/multisite.md) | Host resolution, theming, isolation |

---

### 02 System Specs

| Document | Description |
|----------|-------------|
| [Database Schema](docs/02-system/database.md) | Entities, relations, indexes |
| [API Contract](docs/02-system/api.md) | Endpoints, DTOs, auth |
| [Ingestion Pipeline](docs/02-system/ingestion.md) | EPUB/PDF parsing, worker flow |
| [Reader Spec](docs/02-system/reader.md) | Kindle-like reader, offline sync |
| [Admin Panel](docs/02-system/admin.md) | Admin features, permissions |

---

### 03 Operations

| Document | Description |
|----------|-------------|
| [Local Development](docs/03-ops/local-dev.md) | Docker setup, migrations, debugging |
| [Production Deployment](docs/03-ops/deployment.md) | Server setup, Cloudflare Tunnel, nginx |
| [CI/CD Pipeline](docs/03-ops/cicd-plan.md) | GitHub Actions, auto-deploy, backups |
| [Backup & Recovery](docs/03-ops/backup.md) | DB backup, file recovery |
| [Observability](observability/README.md) | Logs, metrics, traces, dashboards, alerts |

---

### 04 Development Guides

| Document | Description |
|----------|-------------|
| [Testing](docs/04-dev/testing.md) | Unit, integration, E2E tests |
| [Security](docs/04-dev/security.md) | Auth, OWASP, threat model |

---

### Architectural Decision Records (ADRs)

| ADR | Decision |
|-----|----------|
| [001](docs/01-architecture/adr/001-storage-bind-mounts.md) | Storage via bind mounts (not S3) |
| [002](docs/01-architecture/adr/002-google-auth-only.md) | Google OAuth only (no email/pass) |
| [003](docs/01-architecture/adr/003-work-edition-model.md) | Work/Edition data model for multilang |
| [004](docs/01-architecture/adr/004-postgres-fts.md) | PostgreSQL FTS over Elasticsearch |
| [005](docs/01-architecture/adr/005-multisite-resolution.md) | Multisite via Host header |
| [006](docs/01-architecture/adr/006-modular-monolith.md) | Modular monolith over microservices |

---

### Archive

Historical/superseded docs in [docs/archive/](docs/archive/)
