# Local Development

## Prerequisites

- Docker + Docker Compose
- .NET 10 SDK (to run the backend without Docker)
- Node.js (version in `.nvmrc`) and pnpm

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

The schema is plain SQL in [`database/`](../../database/README.md) ([ADR-026](../01-architecture/adr/ADR-026-sql-first-migrations.md)).
Only the `migrator` service applies it — the Api never migrates, also not under `dotnet run`. If the
schema is behind the Api's build, the Api logs Critical at start and `/health/ready` answers 503 with
`components.schema.pending` until the migrator runs.

```bash
docker compose up            # runs the migrator (up) before api and worker
make migrate                 # the same, on its own
make migrate-status          # applied, pending, unknown versions
make migrate-down V=3        # revert every version above 3
```

The `make` targets mount this checkout's `database/` into the migrator, so a migration just written
runs without rebuilding the image. A plain `docker compose up` runs the image's own copy — to the
image's head, which misses migrations written since the last `make build`. After a `down`, restart the
Api with `docker compose restart api` (or `up -d --no-deps api`); `make migrate` brings it back up.

Rolling back a release: **schema first, with the current image**, check `/health/ready` shows the
expected `pending`, **then** the code (`rollback_commit`). An older image has no down files for newer
versions; `down` exits 1 if asked
([ADR-026](../01-architecture/adr/ADR-026-sql-first-migrations.md#rolling-back-a-release-with-a-migration--order-unchanged-from-adr-021)).

### Create New Migration

A numbered pair, `database/migrations/NNNN_<name>.up.sql` + `.down.sql`, with the header from
[`database/README.md`](../../database/README.md#adding-a-migration). Change the EF mapping to match;
`SchemaDriftTests` checks the two agree.

## Run Without Docker

### Backend
```bash
# API (does not migrate). Compose db: `make migrate`. Any other Postgres:
#   PGHOST=localhost PGUSER=app PGPASSWORD=changeme PGDATABASE=books sh database/migrate.sh up
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
