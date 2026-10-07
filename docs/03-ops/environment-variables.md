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
| `POSTGRES_DB` | Yes | `books` | Database name |
| `ConnectionStrings__Default` | Auto | — | Full connection string (auto-built from above) |

### ASP.NET Core

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ASPNETCORE_ENVIRONMENT` | No | `Production` | `Development` / `Production` |
| `ASPNETCORE_URLS` | No | `http://+:8080` | Listen URLs |

### Authentication

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JWT_SECRET` | Yes | — | JWT signing key (min 32 chars) → `Jwt__SecretKey` |
| `JWT_ISSUER` | Yes | — (no compose default) | JWT issuer claim → `Jwt__Issuer` |
| `JWT_AUDIENCE` | Yes | — (no compose default) | JWT audience claim → `Jwt__Audience` |
| `GOOGLE_CLIENT_ID` | Yes | — | Google OAuth client ID → `Google__ClientId` |
| `GOOGLE_LEGACY_CLIENT_IDS` | No | empty | Comma-separated extra client IDs accepted during rotation |

### LLM / email / telemetry

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | For translate/explain/tutor | empty | → `OpenAI__ApiKey` (api **and** worker) |
| `OPENAI_MODEL` | No | `gpt-4.1-nano` | Default model (translate) → `OpenAI__Model` |
| `OPENAI_EXPLAIN_MODEL` | No | `gpt-4.1-mini` | Explain model → `OpenAI__Explain__Model` |
| `RESEND_API_KEY` | For password reset | empty | → `Resend__ApiKey` |
| `RESEND_FROM_EMAIL` | No | `noreply@textstack.app` | → `Resend__FromEmail` |
| `ADMIN_ALERT_EMAIL` | No | empty (alerts off) | SEO backfill / ops failure alerts → `Resend__AdminAlertEmail` |
| `SENTRY_DSN` | No | empty (Sentry fully off) | Keep `ASPNETCORE_ENVIRONMENT=Development` locally, or dev events land in prod Sentry |
| `GIT_SHA` | No | empty | Build arg → `SENTRY_RELEASE` in the image (set by CI) |

Ollama (`Ollama__BaseUrl`, `Ollama__Model=gemma4:e2b`) and the cache paths (`Tts__CachePath`,
`Explain__CachePath`, `Translate__CachePath`) are hard-coded in `docker-compose.yml`, not read from `.env`.

### SEO / SSG worker

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `INDEXNOW_KEY` | No | empty | IndexNow key. Bing binds the first key it saw — do not rotate |
| `INDEXNOW_ENABLED` | No | `false` | Turn IndexNow pings on |

### PDF content cleanup (`quality-poll.sh`, host script)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CONTENT_CLEANUP_ENABLED` | No | `false` | LLM cleanup pass for low-scoring PDF chapters (feat-0007) |
| `CONTENT_QUALITY_THRESHOLD` | No | `60` | Score below which cleanup runs |
| `CLEANUP_TIMEOUT` | No | `1500` | Per-chapter Claude budget, seconds |

### Test / CI knobs (never set in prod)

| Variable | Default | Maps to |
|----------|---------|---------|
| `ENABLE_TEST_AUTH` | `false` | Test auth endpoints for integration + E2E |
| `GUEST_SESSION_PERMIT_LIMIT` | `3` | `RateLimits__GuestSessionPermitLimit` (per IP / 5 min) |
| `USER_LOGIN_PERMIT_LIMIT` | `10` | `RateLimits__UserLoginPermitLimit` (per IP / min) |
| `CLIP_PERMIT_LIMIT` | `20` | `RateLimits__ClipPermitLimit` |
| `ACCOUNT_DELETE_PERMIT_LIMIT` | `3` | `RateLimits__AccountDeletePermitLimit` |
| `GUEST_DAILY_ENRICHMENT_CAP` | `50` | `Entitlements__Tiers__Guest__DailyEnrichmentCap` |

### Storage

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `Storage__RootPath` | No | `/storage` | Set in `docker-compose.yml`; host dir `./data/storage` |

### Migrations

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MIGRATE_TARGET` | No | (latest) | Target migration name, or `0` to rollback all. One-off only: `docker compose run --rm -e MIGRATE_TARGET=<name> migrator`. **Never in `.env`** — every deploy would roll back ([ADR-021](../01-architecture/adr/ADR-021-migrations-owned-by-the-migrator.md)) |
| `Database__MigrateOnStartup` | No | `false` | Api migrates at start. Honoured only with `ASPNETCORE_ENVIRONMENT=Development`; set by `launchSettings.json` for `dotnet run`, never in compose |

### MCP server (`--profile mcp`)

Set in `docker-compose.yml`: `MCP_TRANSPORT=http`, `TEXTSTACK_API_URL=http://api:8080`,
`TEXTSTACK_SITE_HOST=textstack.app`, `ASPNETCORE_URLS=http://+:8090`. Local stdio mode reads
`TEXTSTACK_MCP_TOKEN` (or uses the device flow). See [mcp.md](../05-features/mcp.md).

## Frontend (Web)

All frontend variables must be prefixed with `VITE_`. They are **build-time**: prod values are
set in `.github/workflows/deploy.yml`, not in `.env`.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VITE_API_URL` | No | `http://localhost:8080` | API base URL (prod: `/api`) |
| `VITE_STORAGE_URL` | No | `VITE_API_URL` | Base for `/storage` files (prod: `https://textstack.app`) |
| `VITE_GOOGLE_CLIENT_ID` | Yes | — | Google OAuth client ID (same as backend) |
| `VITE_CANONICAL_URL` | No | — | Canonical URL for prerender |

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
POSTGRES_DB=textstack_prod
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

## SEO Verification (Optional)

Set in `apps/web/index.html` meta tags:

| Variable | Description |
|----------|-------------|
| Google Site Verification | `<meta name="google-site-verification" content="xxx">` |
| Bing Site Verification | `<meta name="msvalidate.01" content="xxx">` |

## Security Notes

- Never commit `.env` or `.env.production` to git
- Use strong passwords (32+ chars) for `JWT_SECRET`
- Rotate secrets periodically
- Use different credentials for dev vs prod

## See Also

- [Local Development](local-dev.md)
- [Production Deployment](deployment.md)
