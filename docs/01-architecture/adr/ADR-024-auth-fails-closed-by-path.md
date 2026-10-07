# ADR-024 — Auth fails closed by path: `/me` and `/internal` like `/admin`

**Status:** Accepted · **Date:** 2026-10-07 · **Review:** [2026-10 #18](../review-2026-10/00-summary.md)
(security M3) · **Related:** [ADR-014](ADR-014-guest-sessions.md) (guests have sessions),
[ADR-017](ADR-017-mcp-oauth-authorization-server.md) (assistant credentials), review #19 (admin roles,
audit) · **Implement after:** the Play production launch (~2026-10-16)

## Context

The Api registers no ASP.NET authentication middleware. Access is decided in five ways:

| Mechanism | Where | Routes |
|---|---|---|
| **Manual `GetUserId` + `if null → 401`** in each handler | `Api/Extensions/ClaimsPrincipalExtensions.cs:51-58`; Vocabulary wraps it in `TryGetAuth` (`VocabularyEndpoints.cs:727-734`) | ~120 user routes, 124 call sites |
| **Admin middleware by path** | `Program.cs:377-380`: `UseWhen(/admin but not /admin/auth) → AdminAuthMiddleware` (`Middleware/AdminAuthMiddleware.cs:10-33`) | 115 routes |
| **Internal network check** in each handler | `InternalNetwork.IsLocalRequest` (`Extensions/InternalNetwork.cs:21`), copied into 20 handlers (`InternalEndpoints.cs` ×15, `InternalSeoEndpoints.cs` ×5); nginx also refuses `/api/internal/` (#690) | 20 |
| **Capability filters** on top of a user | `RequireAiAccount()` (`AiAccountPolicy.cs:30-32`), `RejectOAuthTokens()` (`OAuthTokenPolicy.cs:16-18`, 6 groups) | — |
| **Credential resolution** | `McpKeyAuthMiddleware` (`Program.cs:369`) turns a `tsk_`/`tso_` bearer into `Items[UserId]`, read first by `GetUserId` | — |

Public by design (~57): catalog (`/books`, `/authors`, `/genres`, `/search`, `/seo`, `/ssg`, `/site`),
`/app/config`, `/mcp/manifest`, translate, TTS, explain (user optional), `/auth/*` sign-in routes, the
OAuth AS routes and `/.well-known`, `/auth/device/code|token`, `/admin/auth/*`, `/health`, `/health/ready`.

Totals: **312 mapped routes** (310 in `Api/Endpoints/` + 2 in `Program.cs:198,213`).

The review found **no hole today**. The risk is the design: `/admin` is fail-closed by path, but a new
`/me/...` handler that forgets its check is public, and so is a new `/internal/...` handler. Nothing lists
the routes, so "no hole" was a manual read.

User routes **outside** `/me` (they keep their handler checks): `/auth/me`, `/auth/device/approve`,
`/auth/device/deny`, `/oauth/authorize/approve`, `/oauth/authorize/deny`, `/oauth/token-status`.

## Decision

### 1. Two more path gates, next to `AdminAuth`

In `Program.cs`, beside the existing `/admin` `UseWhen`, after `McpKeyAuth` and the rate limiter:

- **`/me/*`** → 401 when `GetUserId` is null. `OPTIONS` passes through (CORS preflight).
- **`/internal/*`** → 403 when `!InternalNetwork.IsLocalRequest`.

Then delete the 20 per-handler `IsLocalRequest` checks. User handlers keep their `GetUserId` calls (they
need the id anyway). A path gate works wherever an endpoint is mapped, needs no metadata, and rejects
**before body binding**, so an anonymous upload is refused before it is read.

### 2. A snapshot of everything else

`RoutesSnapshotTests` (UnitTests) builds the Api in-process with `WebApplicationFactory`, environment
`Test`, `ENABLE_TEST_AUTH=true` (so the test-login route is listed too), hosted services removed, and
writes every route **not** under `/admin`, `/me` or `/internal` as `METHOD path`. It must equal the
checked-in `routes.public.txt`. A new public route, or a user route outside `/me`, is a diff a reviewer
must read.

`WebApplicationFactory<Program>` is ambiguous here: UnitTests references both the Api and the MCP server,
and each has a top-level `Program`. Use a marker type from the Api (`WebApplicationFactory<Api.ApiMarker>`).

### 3. PR 0: prove it first

An IntegrationTests sweep calls every `/me/*` route anonymously against the running Api and expects 401.
Run it on `main` before the gate exists: if anything under `/me` answers anonymously on purpose, we
learn it now. It stays as the regression test.

### `/storage`: uploads are public to anyone with the URL

Not a route-auth item, but the same question. Readers' originals are served with **no auth** by
`UseStaticFiles` (`Program.cs:183-193`, `/storage`) and by nginx (`alias …/data/storage/`,
`infra/nginx/textstack.conf:365`, `:510`, `:585`). The path is
`users/{userId[..2]}/{userId}/books/{userBookId}/original.<ext>` (`UserBookService.cs:51`,
`LocalFileStorageService`), built from two ids the API hands out. Anyone who learns them can download a
private book. The sandbox headers (#690) stop script execution, not reading. The authenticated route
already exists: `GET /me/books/{id}/file`.

**Owner decision.** Accept the risk, or move uploads out of the static root so they are reachable only
through `/me/books/{id}/file`. **Recommended: move them.**

### `/internal`: a later hardening note

`ForwardedHeaders` trusts `X-Forwarded-For` from 127/8, 10/8, 172.16/12, **192.168/16** and fc00::/7 with
`ForwardLimit = null` (`Program.cs:153`, `:164`). A client on the home LAN can send a spoofed header and be
seen as "local" by `IsLocalRequest`. nginx refuses `/api/internal/` from outside, so this is LAN-only.
Later item: a shared-secret header for `/internal` callers (the pollers, ssg-worker, `backup.yml`).

`/ssg/*` stays public (route lists of published content).

## Alternatives

| Option | Verdict | Why |
|---|---|---|
| **Do nothing** | rejected | The next `/me` handler is one missing line from a data leak, and nothing would say so. |
| **Access class per route group + root endpoint filter** (first draft: `Access` enum, 4 extension methods, root group, 42 signature changes) | dropped by the consilium | More code for the same result; a filter runs after body binding; it only covers endpoints mapped on the root group. |
| **Native ASP.NET auth** (`AuthenticationHandler`, `FallbackPolicy`) | rejected for now | Three credential kinds, admin as a second scheme, a pipeline order that already broke once (#555), and different 401 headers for MCP clients (ADR-017). Revisit with roles (#19). |
| **Only the snapshot test** | runner-up | Catches a new public route, but a new `/me` route would still rely on its handler. The gate is ~15 lines. |

## Consequences

- A forgotten check under `/me` or `/internal` is a 401/403, not a leak.
- Every route outside the three gated prefixes is listed in one file.
- 20 copies of the internal check become one.
- The ~6 user routes outside `/me` still rely on their handlers; the snapshot makes them visible.

## Migration plan (PR-sized, no behaviour change)

0. Anonymous `/me/*` sweep in IntegrationTests, run on `main`.
1. `/me` and `/internal` gates; delete the 20 `IsLocalRequest` checks; `ApiMarker`; `RoutesSnapshotTests`
   + `routes.public.txt`.
2. `/storage` per the owner's answer.
3. Later: shared secret for `/internal`; admin roles and audit with #19.

## Owner decisions (2026-10-07)

All as recommended.

1. **`/storage` uploads:** move behind `/me/books/{id}/file`. Readers' files leave the static root.
2. **`routes.public.txt`:** accepted as a review gate.
3. **Shared secret for `/internal` callers:** yes, as a later item, after #19.
