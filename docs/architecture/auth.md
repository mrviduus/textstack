# User Authentication

Google, Apple and email/password sign-in, plus anonymous **guest** sessions. JWT access token +
rotating refresh token. Web keeps both in HttpOnly cookies; mobile (`X-Client: mobile`) gets them in
the response body and stores them in SecureStore.

Checked against code 2026-11-17. Guest posture and its rejected alternatives:
[ADR-014](adr/ADR-014-guest-sessions.md). Admin sign-in is separate (the admin panel) and is not covered here.
Cookies, CORS, rate limits: [security.md](security.md).

## Flow

```
Client ──POST /auth/{google|apple|login|register|guest}──▶ API
           │                                               1. verify credential (Google/Apple ID token, BCrypt password)
           │                                               2. find/create User (google_subject / apple_subject / email)
           │                                               3. if a guest bearer came along: promote (register) or merge (sign-in)
           ◀── access JWT (60 min) + refresh token (365 d; guest 30 d)
               web: HttpOnly cookies `access_token`, `refresh_token`
               mobile: JSON body
```

- **Refresh** — `POST /auth/refresh` (cookie) or `/auth/refresh-mobile` (body). The old refresh row
  is deleted and a new one issued (rotation); a concurrent second use returns null → 401.
- **Logout** — `POST /auth/logout` deletes the refresh row and clears cookies.
- **Identity on requests** — there is no ASP.NET authentication middleware. Endpoints read the
  token per request (`GetUserId`, cookie or `Authorization: Bearer`).
- **Guest merge** — clients must send `Authorization` on `/auth/register|login|google|apple`, and
  refresh an expiring token first (`packages/shared/src/api/tokenExpiry.ts`): an expired bearer is
  ignored and nothing merges. Responses may carry `guestMergeSkipped`.

## API Endpoints

| Endpoint | Method | Notes |
|----------|--------|-------|
| `/auth/google` | POST | Google ID token |
| `/auth/apple` | POST | Apple ID token |
| `/auth/register` | POST | Email + password; promotes a guest row in place |
| `/auth/login` | POST | Email + password |
| `/auth/guest` | POST | Mint guest user; rate limit `guest-session` (3 / IP / 5 min) |
| `/auth/refresh` · `/auth/refresh-mobile` | POST | Rotate refresh token |
| `/auth/logout` | POST | |
| `/auth/forgot-password` · `/auth/reset-password` | POST | Email via Resend |
| `/auth/me` | GET | Current user |
| `/auth/test-login` | POST | Only when `ENABLE_TEST_AUTH=true` |
| `/me/profile` | GET/PUT | + `POST/DELETE /me/profile/avatar` |
| `/me/account` | DELETE | Hard delete (rate limit `account-delete`) |

`/auth/*` refuses MCP OAuth tokens (`RejectOAuthTokens()`). Login/register/reset are rate-limited
by `user-login` (10 / IP / min).

## Cookies (web)

`HttpOnly`, `Secure` outside Development, `SameSite=Lax`, `Path=/`, `MaxAge` = refresh TTL (both
cookies, re-set on every refresh so an active session slides).

## User data endpoints

The sync API under `/me/v2` (`V2Endpoints.cs`): library, reading state, annotations (highlights, notes
and bookmarks are all annotations), vocabulary, shares/checkpoints/insights. Routes:
[`backend/CLAUDE.md`](../../backend/CLAUDE.md) "API endpoints".

## Database

`users`: `email` (guests get `guest-<hex>@guest.local`), `name`, `picture`, `password_hash?`,
`google_subject?`, `apple_subject?` (each unique where not null), `is_guest`, `promoted_at`,
`last_active_at`, `tier`, `role` (`reader` / `admin`), `native_language`, storage counters.

`user_refresh_tokens`: `user_id`, `token_hash` (unique), `kind`, `family_id`, `expires_at`, `created_at`
(`SessionTokenRepository`).

## Key Files

| File | Purpose |
|------|---------|
| `apps/web/src/context/AuthContext.tsx` | Web auth context |
| `apps/web/src/api/auth.ts` | Web API client |
| `apps/mobile/src/context/AuthContext.tsx` | Mobile auth context |
| `apps/mobile/src/lib/capabilities.ts` | Guest vs account policy (mobile) |
| `backend/src/Api/Endpoints/AuthEndpoints.cs` | Auth endpoints, cookies |
| `backend/src/Application/Identity/V2AuthService.cs` | Sign-in, refresh rotation, guest promote/merge |
| `backend/src/Domain/Identity/UserAccount.cs` | User entity |

## Configuration

```env
# Frontend (build-time)
VITE_GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com

# Backend (.env → docker-compose)
GOOGLE_CLIENT_ID=...           # → Google__ClientId
GOOGLE_LEGACY_CLIENT_IDS=      # → Google__LegacyClientIds
JWT_SECRET=...                 # → Jwt__SecretKey
JWT_ISSUER=textstack.app       # → Jwt__Issuer
JWT_AUDIENCE=textstack.app     # → Jwt__Audience
RESEND_API_KEY=...             # password reset
```

TTLs: `Jwt:AccessTokenExpiryMinutes` (60), `Jwt:RefreshTokenExpiryDays` (365),
`Jwt:GuestRefreshTokenExpiryDays` (30) in `backend/src/Api/appsettings.json`.
