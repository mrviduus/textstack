# ADR-024 — Every route declares its access; unclassified fails closed

**Status:** Proposed · **Date:** 2026-10-07 · **Review:** [2026-10 #18](../review-2026-10/00-summary.md)
(security M3) · **Related:** [ADR-014](ADR-014-guest-sessions.md) (guests have sessions),
[ADR-017](ADR-017-mcp-oauth-authorization-server.md) (assistant credentials), review #19 (admin roles,
audit) · **Implement after:** the Play production launch (~2026-10-16)

## Context

The Api registers no ASP.NET authentication or authorization middleware. Each endpoint decides for
itself, in five different ways:

| Mechanism | Where | Routes |
|---|---|---|
| **Manual `GetUserId` + `if null → 401`** in the handler | `Api/Extensions/ClaimsPrincipalExtensions.cs:51-58`; Vocabulary wraps it in `TryGetAuth` (`VocabularyEndpoints.cs:727-734`) | ~120 user routes in 16 files (`/me/*`, `/auth/me`, two device and four OAuth routes) |
| **Admin middleware by path** | `Program.cs:377-380`: `UseWhen(/admin but not /admin/auth) → AdminAuthMiddleware` (`Middleware/AdminAuthMiddleware.cs:10-33`, cookie JWT) | 115 routes in 11 `Admin*Endpoints` files |
| **Internal network check** in each handler | `InternalNetwork.IsLocalRequest` (`Extensions/InternalNetwork.cs:21`), copied into 20 handlers (`InternalEndpoints.cs` ×15, `InternalSeoEndpoints.cs` ×5); nginx also refuses `/api/internal/` (#690) | 20 |
| **Capability filters** on top of a user | `RequireAiAccount()` (`AiAccountPolicy.cs:30-32`, tutor); `RejectOAuthTokens()` (`OAuthTokenPolicy.cs:16-18`, on 6 groups: profile, account, MCP keys, auth, device, OAuth grants) | — |
| **Credential resolution** before the handlers run | `McpKeyAuthMiddleware` (`Program.cs:369`) turns a `tsk_`/`tso_` bearer into `Items[UserId]`, which `GetUserId` reads first | — |
| **Public by design** | catalog (`/books`, `/authors`, `/genres`, `/search`, `/seo`, `/ssg`, `/site`), `/app/config`, `/mcp/manifest`, translate, TTS, explain (user optional), `/auth/*` sign-in routes, `/oauth/*` AS routes + `/.well-known`, `/auth/device/code|token`, `/admin/auth/*`, `/health`, `/health/ready` | ~57 |

Totals: **312 mapped routes** (310 in `Api/Endpoints/` + 2 health checks in `Program.cs:198,213`).

The review found **no hole today**. The risk is the design: a new `/me/...` handler that forgets the
`GetUserId` check is public, and nothing fails. The admin side is already fail-closed by path; the user
and internal sides are fail-open. There is no test that lists the routes, so "no hole" was a manual read
of 312 routes.

## Decision

### Four access classes, set on the route group

```csharp
// Api/Extensions/RouteAccess.cs
public enum Access { Public, User, Admin, Internal }

group.Public()       // anyone; a handler may still read an optional user (explain, /auth/login merge)
group.RequireUser()  // GetUserId != null, else 401
group.AdminOnly()    // admin cookie (AdminAuthMiddleware stays the enforcer for now)
group.InternalOnly() // InternalNetwork.IsLocalRequest, else 403
```

Each call adds one `AccessMetadata(Access)` to the endpoint metadata. A route may override its group
(the last one wins), which mixed groups need: `/auth` is public except `/auth/me`; `/auth/device` and
`/oauth` are public except approve/deny.

### One filter on one root group: missing class = `User`

All `Map*Endpoints` move onto one root group, `var api = app.MapGroup("").AddEndpointFilter<RouteAccessFilter>()`.
The filter reads the endpoint's `AccessMetadata` and enforces it. **No metadata is treated as `User`**,
so a forgotten classification fails closed (401), never open. The filter returns the same status codes
the handlers return today (401 / 403), so clients see no change.

The capability filters stay as they are and run after it (`RequireAiAccount`, `RejectOAuthTokens`): they
answer "which user may do this", not "who is calling".

### One test fails CI on an unclassified or misfiled route

`RouteAccessTests` (UnitTests) boots the Api in-process with `WebApplicationFactory<Program>`, environment
`Test` (already skips the JWT and DB startup checks, `Program.cs:53,77`), hosted services removed, and reads
every `RouteEndpoint` from `EndpointDataSource`. It asserts:

1. every endpoint has **exactly one effective** `Access` (unclassified = fail);
2. path ⇔ class: `/admin/*` (not `/admin/auth/*`) ⇔ `Admin`; `/internal/*` ⇔ `Internal`; `/me/*` ⇒ `User`;
3. the list of `Public` routes equals a checked-in file, `RouteAccess.public.txt`. A new public route
   therefore shows up as a diff a reviewer must read.

## Alternatives

| Option | Verdict | Why |
|---|---|---|
| **Do nothing** | rejected | No hole today, but the next `/me` handler is one missing line from a data leak, and nothing would tell us. |
| **Only the test, no filter** | runner-up | Catches a missing class in CI, but a classified-`User` route still relies on the handler's own check. The filter is ~40 lines; take both. |
| **Native ASP.NET auth**: a custom `AuthenticationHandler` over `AuthService.ValidateAccessToken`, `FallbackPolicy = RequireAuthenticatedUser`, `AllowAnonymous()` on public groups | rejected for now | The platform way, and it would fill `HttpContext.User` (whose absence hid the guest-activity bug). But it is a bigger change: a handler for three credential kinds, admin as a second scheme, `UseAuthentication/UseAuthorization` placed around the rate limiter and `McpKeyAuth` (an order that already broke once, #555), and different 401 bodies and `WWW-Authenticate` headers for MCP clients (ADR-017). Worth a later ADR if roles (#19) need policies. |
| **Path-prefix middleware for `/me` like `/admin`** | rejected | Fail-closed for `/me` only; `/auth/me`, device approve and OAuth grants live elsewhere. And it hides the rule from the route definition. |
| **Per-route attribute check in code review** | rejected | That is what we have. |

## Consequences

- A new route without a class is a 401 in the app and a red test in CI.
- Every public route is listed in one file in the repo.
- Handlers keep their own `GetUserId` checks at first (redundant, harmless). A later PR may replace the
  3-line preamble with `ctx.RequiredUserId()` reading what the filter stored — about 120 preambles less.
- The 20 internal checks become one.
- An anonymous request is still rejected **after** parameter binding (endpoint filters run there), same
  as today's handler checks; an anonymous upload is still read before its 401. Rejecting earlier needs
  middleware and is out of scope.
- `Map*Endpoints` signatures change from `WebApplication` to `IEndpointRouteBuilder` (42 methods,
  mechanical).

## Migration plan (PR-sized, no behaviour change)

0. **Prove today's behaviour** (no code): an IntegrationTests sweep that calls every future-`User` route
   anonymously against the running Api and expects 401. Run it on `main` first; it is also the PR 1
   regression test.
1. **Classify + filter + test.** `RouteAccess.cs`, the root group, signatures to `IEndpointRouteBuilder`,
   a class on every group (and the overrides), `RouteAccessTests` + `RouteAccess.public.txt`,
   `public partial class Program;` for the factory. Handlers unchanged.
2. **Internal:** delete the 20 `IsLocalRequest` checks. Same 403.
3. **User (optional cleanup):** replace handler preambles with the stored user id.
4. **Admin (with review #19):** fold `AdminAuthMiddleware` into the filter or keep it; add role checks and
   the audit row here, not before.

## Open questions (owner)

1. `/ssg/*` (route lists for the prerenderer) is public today. Keep public or make it `Internal`?
2. Accept the public-routes snapshot file as a review gate?
3. Do the optional PR 3 cleanup, or stop after PR 2?
