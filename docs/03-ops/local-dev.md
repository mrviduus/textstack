# Local Development

## Prerequisites

- Docker + Docker Compose
- .NET 10 SDK (for migrations without Docker)
- Node.js 18+ and pnpm

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

## Nginx Gateway (Host-based Routing)

For prod-like host-based routing, use nginx gateway on port 80:

| Host | Target |
|------|--------|
| http://general.localhost | Web (public site) |
| http://api.localhost | API |
| http://admin.localhost | Admin |

**Note:** `*.localhost` resolves to 127.0.0.1 by default on most systems.

```bash
# Test API via gateway
curl http://api.localhost/health
curl http://api.localhost/debug/site
# => {"site":"general"}
```


## Migrations

Migrations run automatically via dedicated Docker service.

### Apply All (default)
```bash
docker compose up
```

### Target Specific Migration
```bash
MIGRATE_TARGET=Initial_Content docker compose up migrator
```

### Rollback All
```bash
MIGRATE_TARGET=0 docker compose up migrator
```

### Create New Migration
```bash
dotnet ef migrations add <Name> \
  --project backend/src/Infrastructure \
  --startup-project backend/src/Api
```

### Local (without Docker)
```bash
dotnet ef database update \
  --project backend/src/Infrastructure \
  --startup-project backend/src/Api
```

## Run Without Docker

### Backend
```bash
# API
dotnet run --project backend/src/Api

# Worker
dotnet run --project backend/src/Worker
```

Requires PostgreSQL running locally or via Docker.

### Frontend
```bash
# Web
pnpm -C apps/web dev

# Admin
pnpm -C apps/admin dev
```

## Storage

Files stored at `./data/storage`:
```
./data/storage/books/{editionId}/original/{filename}.epub
./data/storage/books/{editionId}/derived/cover.jpg
```

DB stores paths only. Containers mount via bind mount.

## Environment Variables

Copy `.env.example` to `.env` for overrides.

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_PASSWORD` | `postgres` | DB password |
| `STORAGE_PATH` | `/storage` | Container path |
| `MIGRATE_TARGET` | (latest) | Target migration |

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Migrator exits 1 | `docker compose logs migrator` |
| API won't start | Check migrator completed |
| Port conflict | Change ports in compose |
| Stale containers | `docker compose down -v` |

## Useful Commands

```bash
# View logs
docker compose logs -f api
docker compose logs -f worker

# Rebuild single service
docker compose up --build api

# Reset everything
docker compose down -v
rm -rf ./data/postgres ./data/storage
docker compose up --build

# Database shell
docker compose exec db psql -U app books
```

## See Also

- [Backup](backup.md) — Backup procedures
