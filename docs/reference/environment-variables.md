# Environment Variables

Reference for the variables `docker-compose.yml` reads from `.env` (source of truth: `.env.example` + `docker-compose.yml`, checked 2026-10-04).

## Quick Start

```bash
cp .env.example .env
# Edit .env with your values
```

## Backend (API + Worker)

### Database

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `POSTGRES_USER` | Yes | `app` | PostgreSQL username |
| `POSTGRES_PASSWORD` | Yes | — | PostgreSQL password |
| `POSTGRES_DB` | Yes | `books` | Init database only: the postgres image creates it on an empty volume, the db healthcheck names it; nothing connects to it. Never the V2 one on a new install (initdb would create it without ICU); on an existing server, the V2 database |
| `TEXTSTACK_DB` | No | `textstack_v2` | The database Api and Worker read (`ConnectionStrings__Default`, auto-built); required at startup |

### ASP.NET Core

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ASPNETCORE_ENVIRONMENT` | No | `Production` | `Development` / `Production` |
| `ASPNETCORE_URLS` | No | `http://+:8080` | Listen URLs |
| `App__BaseUrl` | No | `https://textstack.app` (appsettings.json) | Public site origin: OAuth issuer, device-flow page, MCP manifest, email links. Must equal the MCP server's `TEXTSTACK_PUBLIC_URL` |
| `MAINTENANCE_WRITE_FREEZE` | No | `false` | API HTTP write barrier → `Maintenance__WriteFreeze`; writes answer 503 `write_frozen` (`v2_unavailable` for `/me/v2`) with `Retry-After: 60`. Reads remain available; OAuth authorization GET/HEAD is blocked because it writes. Recreate the Api to change it; other writer processes must be stopped/drained separately. [M5.1 preparation](../internal/v2/m5-1-preparation.md) |

### Authentication

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JWT_SECRET` | Yes | — | JWT signing key (min 32 chars) → `Jwt__SecretKey` |
| `JWT_ISSUER` | Yes | — (no compose default) | JWT issuer claim → `Jwt__Issuer` |
| `JWT_AUDIENCE` | Yes | — (no compose default) | JWT audience claim → `Jwt__Audience` |
| `GOOGLE_CLIENT_ID` | Yes | — | Google OAuth client ID → `Google__ClientId` |
| `GOOGLE_LEGACY_CLIENT_IDS` | No | empty | Comma-separated extra client IDs accepted during rotation |
| `APPLE_BUNDLE_ID` | No | `app.textstack.mobile` | iOS bundle id, the audience Apple identity tokens must name → `Apple__BundleId`; Apple sign-in is refused if the setting ends up empty |

### LLM / email / telemetry

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | For translate/explain/tutor | empty | → `OpenAI__ApiKey` (api **and** worker) |
| `OPENAI_MODEL` | No | `gpt-4.1-mini` (in `OpenAiOptions`) | Default model (translate) → `OpenAI__Model`. Empty = the code default |
| `OPENAI_EXPLAIN_MODEL` | No | `gpt-4.1-mini` (in `OpenAiOptions`) | Explain model → `OpenAI__Explain__Model`. Empty = the code default |
| `RESEND_API_KEY` | For password reset | empty | → `Resend__ApiKey` |
| `RESEND_FROM_EMAIL` | No | `noreply@textstack.app` | → `Resend__FromEmail` |
| `ADMIN_ALERT_EMAIL` | No | empty (alerts off) | AI spend / ops alerts → `Resend__AdminAlertEmail` |
| `SENTRY_DSN` | No | empty (Sentry fully off) | Keep `ASPNETCORE_ENVIRONMENT=Development` locally, or dev events land in prod Sentry |
| `GIT_SHA` | No | empty | Build arg → `SENTRY_RELEASE` in the image (set by CI) |

Ollama (`Ollama__BaseUrl`, `Ollama__Model=gemma4:e2b`) and the cache paths (`Tts__CachePath`,
`Explain__CachePath`, `Translate__CachePath`) are hard-coded in `docker-compose.yml`, not read from `.env`.

### Test / CI knobs (never set in prod)

| Variable | Default | Maps to |
|----------|---------|---------|
| `ENABLE_TEST_AUTH` | `false` | Test auth endpoints for integration + E2E |
| `GUEST_SESSION_PERMIT_LIMIT` | `3` | `RateLimits__GuestSessionPermitLimit` (per IP / 5 min) |
| `USER_LOGIN_PERMIT_LIMIT` | `10` | `RateLimits__UserLoginPermitLimit` (per IP / min) |
| `CLIP_PERMIT_LIMIT` | `20` | `RateLimits__ClipPermitLimit` |
| `ACCOUNT_DELETE_PERMIT_LIMIT` | `3` | `RateLimits__AccountDeletePermitLimit` |
| `DEVICE_CODE_PERMIT_LIMIT` | `5` | `RateLimits__DeviceCodePermitLimit` (per IP / min) |
| `GUEST_DAILY_ENRICHMENT_CAP` | `50` | `Entitlements__Tiers__Guest__DailyEnrichmentCap` |

### Storage

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `Storage__RootPath` | No | `/storage` | Set in `docker-compose.yml`; host dir `./data/storage` |
| `Storage__LibraryRoot` | No | `/library` | V2 library bytes; host dir `./data/library`. Must not nest with `Storage__RootPath` (served publicly) either way, nor equal it: startup fails otherwise. V2 files left in `library/` or `uploads/` under the root only log a warning with the move command (the `/storage` denylist keeps them private) (#1110) |

### Migrations

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | Yes (migrator) | — | libpq connection for `database/migrate.sh`; compose sets them from `POSTGRES_*`. The rollback target is an argument (`docker compose run --rm migrator down <version>`), not a variable ([ADR-026](../architecture/adr/ADR-026-sql-first-migrations.md)) |

### MCP server (`--profile mcp`)

Set in `docker-compose.yml`: `MCP_TRANSPORT=http`, `TEXTSTACK_API_URL=http://api:8080`,
`TEXTSTACK_SITE_HOST=textstack.app`, `ASPNETCORE_URLS=http://+:8090`. Local stdio mode reads
`TEXTSTACK_MCP_TOKEN` (or uses the device flow). See [mcp.md](mcp.md).

## Frontend (Web)

All frontend variables must be prefixed with `VITE_`. They are **build-time**: prod values are
set in `.github/workflows/deploy.yml`, not in `.env`.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VITE_API_URL` | No | `http://localhost:8080` | API base URL (prod: `/api`) |
| `VITE_STORAGE_URL` | No | `VITE_API_URL` | Base for `/storage` files (prod: `https://textstack.app`) |
| `VITE_GOOGLE_CLIENT_ID` | Yes | — | Google OAuth client ID (same as backend) |
| `VITE_CANONICAL_URL` | No | — | Canonical URL (`SeoHead`) |

## Frontend (Admin)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VITE_API_URL` | No | `http://localhost:8080` | API base URL |

## Environment Examples

### Local Development (.env)

```bash
POSTGRES_USER=app
POSTGRES_PASSWORD=changeme
POSTGRES_DB=books
ASPNETCORE_ENVIRONMENT=Development
JWT_SECRET=dev-secret-key-minimum-32-characters-long
JWT_ISSUER=textstack.app
JWT_AUDIENCE=textstack.app
GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
```

### Production (.env)

```bash
POSTGRES_USER=textstack_prod
POSTGRES_PASSWORD=<strong-password>
POSTGRES_DB=textstack_v2
ASPNETCORE_ENVIRONMENT=Production
JWT_SECRET=<256-bit-secret>
JWT_ISSUER=textstack.app
JWT_AUDIENCE=textstack.app
GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
```

**Note:** Both dev and prod use `.env`. Docker Compose reads it automatically.

## Docker Compose

Variables are passed to containers via environment section:

```yaml
services:
  api:
    environment:
      - ConnectionStrings__Default=Host=db;...
      - JWT_SECRET=${JWT_SECRET}
```

Docker Compose automatically reads `.env` file in the project root.

## Security Notes

- Never commit `.env` or `.env.production` to git
- Use strong passwords (32+ chars) for `JWT_SECRET`
- Rotate secrets periodically
- Use different credentials for dev vs prod

## See Also

- [Local Development](../start/run-locally.md)
- [Production Deployment](../internal/ops/deployment.md)
