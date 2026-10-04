# Security

## Authentication

### Public Users
- Google, Apple, and email/password (reset via Resend); anonymous guest sessions (ADR-014)
- JWT access token 60 min + refresh token 365 days (guest: 30) — `Jwt:*` in `appsettings.json`
- MCP: OAuth access tokens (`tso_…`, 1h, refresh 90d, ADR-017), connect keys (`tsk_…`), device-flow JWT
- No ASP.NET auth middleware: endpoints resolve identity per request (`GetUserId`)

### Admin Users
- Separate email/password auth
- Stored in `admin_users` table
- Password hashed with BCrypt (`AdminAuthService`)
- Token in `admin_access_token` cookie, checked by `AdminAuthMiddleware` on `/admin/*`
- Role-based access (Admin, Editor, Moderator)

## Authorization

| Route | Access |
|-------|--------|
| `/books/*` | Public |
| `/search` | Public |
| `/me/*` | Authenticated user (guest included) |
| Tutor (paid inference) | Real account — `RequireAiAccount()` → 403 `account_required` |
| `/admin/*` | Admin role |
| `/internal/*` | Docker network only |

## Cookies

- Secure flag in production
- HttpOnly for tokens
- SameSite=Lax (CSRF mitigation)
- Short access token, long refresh token

## CSRF Protection

- SameSite cookies
- Double-submit cookie pattern (if needed)
- State mutations require auth

## CORS

Development:
- Allow localhost origins
- Credentials allowed

Production:
- Whitelist specific domains
- No wildcards

Origins come from `Cors:AllowedOrigins` (`appsettings.json`), with a fallback list in
`Api/Extensions/ServiceCollectionExtensions.Cors.cs` (localhost dev hosts + `https://textstack.app`,
`https://textstack.dev`). Any header/method, credentials allowed.

## Input Validation

- Validate file types on upload
- Size limits enforced
- SQL injection: use parameterized queries (EF Core)
- XSS: sanitize HTML in chapter content

## HTML Sanitization

Ingestion removes:
- `<script>` tags
- Event handlers (`onclick`, etc.)
- `javascript:` URLs
- Unknown/dangerous attributes

## Secrets Management

| Secret | Location |
|--------|----------|
| DB password | Environment variable |
| JWT signing key | Environment variable |
| Google OAuth | Environment variable |

Never commit secrets to repo. Use `.env` (gitignored).

## Rate Limiting

Live. ASP.NET rate limiter policies in `Api/Extensions/ServiceCollectionExtensions.RateLimiting.cs`
(login, guest-session, device flow, clip, highlight-write, insights, OAuth, mcp-keys, upload, enrich,
tts, translate, explain, tutor, account-delete, …). Most are per IP; `highlight-write` and
`insights` are per user, because MCP traffic arrives from one container address. Knobs in
`RateLimits:*`. nginx adds its own zones (API 10r/s, uploads 1r/s, translation 5r/m, MCP 10r/s).
The limiter was inert until PR #555 (middleware order).

## Logging

- Log auth failures
- Log admin actions (audit log)
- No sensitive data in logs
- Structured logging via `ILogger` → OpenTelemetry (Aspire dashboard); errors → Sentry when `SENTRY_DSN` set

## Checklist

- [ ] Secrets in env vars, not code
- [ ] HTTPS in production
- [ ] Secure cookie flags
- [ ] CORS whitelist
- [ ] Input validation
- [ ] HTML sanitization
- [ ] Rate limiting
- [ ] Audit logging
- [ ] Dependency updates

## See Also

- [ADR-002: Google Auth Only](../01-architecture/adr/002-google-auth-only.md) — superseded in practice (Apple, email/password, guests)
- [ADR-014: Guest sessions](../01-architecture/adr/ADR-014-guest-sessions.md)
- [Admin Panel: Authentication](../02-system/admin.md)
