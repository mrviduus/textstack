# Admin Panel

A shell (M6 D2): login and an empty home. Separate React app (`apps/admin/`), separate auth.
Checked against code 2026-11-17. Knobs are edited by SQL.

## Access

- Prod: `https://textstack.dev` (nginx serves the admin SPA, `X-Robots-Tag: noindex, nofollow`).
  Local: `http://localhost:81`.
- Not linked from the public UI.
- In the repo, protection is the login only — nginx has no IP allowlist (any Cloudflare Access rule would live outside the repo).

## Authentication

An admin is an account with `role = 'admin'` (one role, ADR-031 decided 7), created by the CLI
`create-admin`. Email + password, JWT access token in the `admin_access_token` cookie + a rotating
refresh token (an admin session). `V2AdminAuthService`.

```
POST /admin/auth/login     POST /admin/auth/refresh
POST /admin/auth/logout    GET  /admin/auth/me
```

`AdminAuthMiddleware` guards every `/admin/*` path except `/admin/auth/*`. There is no audit log.

## Pages (`apps/admin/src/pages/`)

Login · Home (empty) · Not found.

## Key files

| File | Purpose |
|------|---------|
| `apps/admin/` | React admin app |
| `backend/src/Api/Endpoints/AdminAuthEndpoints.cs` | `/admin/auth/*` |
| `backend/src/Api/Middleware/AdminAuthMiddleware.cs` | Auth gate |
| `backend/src/Application/Identity/V2AdminAuthService.cs` | Login, refresh, logout |

## See also

- [Data model](../docs/architecture/data-model.md) · CLI `create-admin` in CLAUDE.md
