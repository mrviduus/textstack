# Security

Checked against code 2026-11-18. Sign-in flows, tokens and the admin login: [auth.md](auth.md).
Which paths need what: [ADR-024](adr/ADR-024-auth-fails-closed-by-path.md).

## Authentication

- **Readers**: Google, Apple, email/password (reset via Resend); anonymous guest sessions ([ADR-014](adr/ADR-014-guest-sessions.md)).
  JWT access token 60 min + refresh token 365 days (guest: 30), `Jwt:*` in `appsettings.json`.
- **Assistants (MCP)**: OAuth access tokens (`tso_…`, 1 h, refresh 90 d, [ADR-017](adr/ADR-017-mcp-oauth-authorization-server.md)),
  connect keys (`tsk_…`), device-flow JWT. OAuth tokens and connect keys are refused on account management
  (403 `insufficient_scope`, `RejectOAuthTokens`).
- **Admins**: separate email/password login; an admin is an account with `role = 'admin'` (one role, ADR-031).
  BCrypt, `admin_access_token` cookie, `AdminAuthMiddleware`.
- No ASP.NET authentication middleware: endpoints resolve identity per request (`GetUserId`).

## Authorization

| Route | Access |
|-------|--------|
| `/me/*` | Authenticated user (guest included); 401 without one (`PathGates`) |
| `/admin/*` | Admin login (except `/admin/auth/*`) |
| `/internal/*` | Docker network only; 403 otherwise |

## Cookies and CSRF

Tokens live in `HttpOnly` cookies, `Secure` outside Development, `SameSite=Lax`. Lax cookies plus "every state
change needs auth" are the CSRF defence; there is no CSRF token.

## CORS

Origins come from `Cors:AllowedOrigins` (`appsettings.json`), with a fallback list in
`Api/Extensions/ServiceCollectionExtensions.Cors.cs` (localhost dev hosts + `https://textstack.app`,
`https://textstack.dev`). No wildcard; any header/method, credentials allowed.

## Input

- Uploads: file type and size checked; the storage quota is checked inside the attach.
- SQL: parameterized queries only (Dapper, inline SQL).
- HTML from books: `HtmlCleaner` (`backend/src/Extraction/TextStack.Extraction/Utilities/`) drops `script`/`style`,
  embedding tags (`iframe`, `object`, `form`, `base`, `meta`, …), every `on*` handler and script-capable URL schemes
  (`javascript:`, `vbscript:`, `file:`, `blob:`, `data:text/html`). The reader page itself runs in a sandboxed frame
  under a nonce CSP ([ADR-029](adr/ADR-029-foliate-for-v2-epub.md)).

## Secrets

Only in the server's `.env` (gitignored) at runtime: DB password, JWT signing key, Google client id, OpenAI and
Resend keys, Sentry DSN. Images are secret-scanned before push (`infra/scripts/scan-image-secrets.sh`); the web bundle is
scanned at deploy.

## Rate limiting

ASP.NET rate limiter policies in `Api/Extensions/ServiceCollectionExtensions.RateLimiting.cs` (`user-login`,
`admin-login`, `guest-session`, device flow, `clip`, `assistant-write`, `insights`, OAuth, `mcp-keys`, `tts`,
`translate`, `explain`, `account-delete`). Most are per IP; `assistant-write` and `insights` are per user, because
MCP traffic arrives from one container address. Knobs in `RateLimits:*`. The limiter must follow `Routing` in the
pipeline or per-endpoint policies are inert (they were, until PR #555). nginx adds its own zones (API 10r/s,
uploads 1r/s, translation 5r/m, MCP 10r/s).

## Logging

No tokens or secrets in logs. Errors go to Sentry when `SENTRY_DSN` is set, through one scrubber
(`SentryScrubber.cs`: tokens, Bearer, JWT, `/mcp/k/<key>`, query strings, SQL).

## See also

- [ADR-002: Google Auth Only](adr/002-google-auth-only.md) — superseded in practice (Apple, email/password, guests)
