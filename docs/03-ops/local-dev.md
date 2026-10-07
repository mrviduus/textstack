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
| Web | http://localhost:5173 (not a compose service — run `pnpm -C apps/web dev`) |
| Admin | http://localhost:81 |
| Postgres | not exposed — `docker compose exec db psql -U <POSTGRES_USER> <POSTGRES_DB>` |

## Nginx (prod-like)

`make nginx-setup` (Linux) / `make nginx-setup-mac` install `infra/nginx/textstack.conf` with
paths rewritten to this checkout. It serves `localhost` like `textstack.app` (SSG/SPA + `/api/`
proxy) and `textstack.dev` as admin. There are no `*.localhost` gateway hosts and no
`/debug/site` endpoint any more (single site, ADR-007).

## Migrations

Only the dedicated `migrator` Docker service migrates ([ADR-021](../01-architecture/adr/ADR-021-migrations-owned-by-the-migrator.md));
the Api never does under Docker. If the schema is behind the Api's build, the Api logs Critical at start
and `/health/ready` answers 503 with `components.schema.pending` until the migrator runs.

### Apply All (default)
```bash
docker compose up
```

### Target Specific Migration
```bash
docker compose run --rm -e MIGRATE_TARGET=Initial_Content migrator
```

### Rollback All
```bash
docker compose run --rm -e MIGRATE_TARGET=0 migrator
```

`-e` on a one-off `run`, never `.env`: compose reads `.env` on every `up`, so a target left there would
roll back on every deploy. The old `MIGRATE_TARGET=… docker compose up migrator` form never reached
the container. After a rollback, restart the Api with `docker compose restart api` (or `up -d --no-deps api`);
a plain `docker compose up -d` re-runs the migrator to head.

Rolling back a release: **schema first, with the current image**, check `/health/ready` shows the
expected `pending`, **then** the code (`rollback_commit`). An older image cannot revert migrations it
does not contain; the migrator now exits 1 if asked to
([ADR-021](../01-architecture/adr/ADR-021-migrations-owned-by-the-migrator.md#rolling-back-a-release-with-a-migration--order-matters)).

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
# API (applies pending migrations at start: launchSettings sets Database__MigrateOnStartup;
# under Docker only the `migrator` service migrates)
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
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | none — required | DB credentials |
| `MIGRATE_TARGET` | (latest) | Target migration — pass with `docker compose run --rm -e`, not `.env` |

Full list: [environment-variables.md](environment-variables.md).

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
rm -rf ./data/postgres-prod ./data/storage
docker compose up --build

# Database shell
docker compose exec db psql -U app books
```

## See Also

- [Backup](backup.md) — Backup procedures
