# Environment Variables

Complete reference for all environment variables.

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
| `JWT_SECRET` | Yes | — | JWT signing key (min 32 chars) |
| `JWT_ISSUER` | No | `textstack.app` | JWT issuer claim |
| `JWT_AUDIENCE` | No | `textstack.app` | JWT audience claim |
| `GOOGLE_CLIENT_ID` | Yes | — | Google OAuth client ID |

### Storage

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `STORAGE_PATH` | No | `/storage` | Container path for files |
| `Storage__RootPath` | No | `/storage` | .NET config format |

### Migrations

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MIGRATE_TARGET` | No | (latest) | Target migration name, or `0` to rollback all |

## Frontend (Web)

All frontend variables must be prefixed with `VITE_`.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VITE_API_URL` | No | `http://localhost:8080` | API base URL |
| `VITE_GOOGLE_CLIENT_ID` | Yes | — | Google OAuth client ID (same as backend) |
| `VITE_SITE` | No | `general` | Site override for dev |
| `VITE_CANONICAL_URL` | No | — | Canonical URL for prerender |

## Frontend (Admin)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VITE_API_URL` | No | `http://localhost:8080` | API base URL |

## Production vs Development

### Development (.env)

```bash
POSTGRES_USER=app
POSTGRES_PASSWORD=changeme
POSTGRES_DB=books
ASPNETCORE_ENVIRONMENT=Development
JWT_SECRET=dev-secret-key-minimum-32-characters-long
JWT_ISSUER=localhost
GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
VITE_API_URL=http://localhost:8080
VITE_GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
```

### Production (.env.production)

```bash
POSTGRES_USER=textstack_prod
POSTGRES_PASSWORD=<strong-password>
POSTGRES_DB=textstack_prod
ASPNETCORE_ENVIRONMENT=Production
JWT_SECRET=<256-bit-secret>
JWT_ISSUER=textstack.app
GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
VITE_API_URL=https://api.textstack.app
VITE_GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
VITE_CANONICAL_URL=https://textstack.app
```

## Docker Compose

Variables are passed to containers via:

```yaml
services:
  api:
    environment:
      - ConnectionStrings__Default=Host=db;...
      - JWT_SECRET=${JWT_SECRET}
```

Or via env_file:

```yaml
services:
  api:
    env_file:
      - .env.production
```

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
