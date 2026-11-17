# TextStack Admin Panel

A shell: login and an empty home page. The catalog management pages were retired in M6
(owner decision D2, `docs/internal/v2/m6-deletion-plan.md` A1). Settings are edited by SQL.

## Quick Start

```bash
# From project root
pnpm -C apps/admin dev

# Or via Docker
docker compose up admin
```

**URL**: http://localhost:81

## Commands

```bash
pnpm dev      # Start dev server
pnpm build    # Type-check + build
pnpm preview  # Preview production build
```

## Environment Variables

```env
VITE_API_URL=http://localhost:8080
```

## Authentication

`/admin/auth/*` (cookie session). Create an account with `create-admin <email> <password>`.
