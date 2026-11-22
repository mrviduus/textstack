# Admin panel

Not published on the docs site (docs/internal is hidden). Reader auth: [`docs/architecture/auth.md`](../../architecture/auth.md).

The admin app (`apps/admin/`, prod `https://textstack.dev`, local `http://localhost:81`) is a shell (M6 D2):
login, an empty home, not found. Not linked from the public UI; nginx sends `X-Robots-Tag: noindex, nofollow` and
has no IP allowlist, so the login is the only protection in the repo. Knobs are edited by SQL.

An admin is an account with `role = 'admin'` (one role, ADR-031 decided 7), created by the CLI `create-admin`.
Email + password (BCrypt), JWT access token in the `admin_access_token` cookie + a rotating refresh token.
`AdminAuthMiddleware` guards every `/admin/*` path except `/admin/auth/*`. There is no audit log.

| File | Purpose |
|------|---------|
| `backend/src/Api/Endpoints/AdminAuthEndpoints.cs` | `POST /admin/auth/{login,refresh,logout}`, `GET /admin/auth/me` |
| `backend/src/Api/Middleware/AdminAuthMiddleware.cs` | Auth gate |
| `backend/src/Application/Identity/AdminAuthService.cs` | Login, refresh, logout |
