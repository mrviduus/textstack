# ADR-017 — Our own OAuth authorization server for the MCP endpoint

**Status:** Accepted · **Date:** 2026-09-29 · **Feature:** [mcp.md § Authentication](../../05-features/mcp.md#authentication)

## Context

"Connect TextStack to Claude/ChatGPT" meant creating a connect key (`tsk_…`) and pasting it — as a
header for Claude, inside a URL (`/mcp/k/<key>`) for ChatGPT, whose connectors offer only "No
authentication" or OAuth. Readwise's connector is the bar: paste `https://…/mcp` (or pick it from the
directory), sign in, approve. Both directories require OAuth for user data, and both clients speak the
MCP authorization spec: `401` + `WWW-Authenticate: Bearer resource_metadata=…`, Protected Resource
Metadata (RFC 9728), AS metadata (RFC 8414), authorization code + PKCE S256, public clients registered
by CIMD (preferred) or DCR, `resource` (RFC 8707) → audience, refresh rotation. These client requirements were verified on 2026-09-29 against Readwise's live
endpoints (curl) and the Claude and OpenAI connector docs; the resulting contract is in `mcp.md`.

What already existed: a web login (email/Google/Apple), a device-flow consent page, hashed `tsk_` keys
resolved per request by `McpKeyAuthMiddleware`, and an MCP host that forwarded any bearer and answered
`200` without one (public tools worked anonymously, private ones failed as tool errors — so an OAuth
client would never have started a sign-in).

## Decision

1. **A mini authorization server inside the API**, not OpenIddict or Duende. We need one grant
   (authorization code + PKCE) plus refresh, one client type (public), one scope. Login and sessions
   exist. That is ~400 lines in `OAuthEndpoints.cs` and three tables. OpenIddict (Apache-2.0) would
   bring its own schema and still needs DCR and CIMD written by hand; Duende is commercially licensed
   above $1M revenue and is built for a problem we do not have. Issuer `https://textstack.app`
   (`App:BaseUrl`).
2. **Opaque, hashed tokens, not JWTs.** Access `tso_` (1 h), refresh `tsr_` (90 days, sliding,
   rotated on every use; a reused one matches no row → `invalid_grant`). Our JWT is validated with
   `ValidateAudience = false` and cannot be revoked; the spec requires an audience and the product
   requires instant revocation. The `tsk_` machinery already does "prefix → SHA-256 → row → not
   revoked" in one indexed query; `tso_` adds `expires > now` and `resource = https://textstack.app/mcp`
   to the same query (`OAuth.LiveAccessToken`). Revoking a grant is therefore effective on the next
   request, with no cache.
3. **The bridge does not validate tokens.** The MCP host and the API are one trust domain; the token
   was issued by our AS *for* the MCP resource, and the API enforces that audience. Formally the
   bridge forwards the token it received, which the spec calls token passthrough — the concern there
   is a server replaying a token to a *third party*, which does not happen here. One exception: for a
   `tso_` bearer the host asks `GET /oauth/token-status` and answers an expired/revoked token with
   `401 error="invalid_token"`, because that 401 — not a 200 whose tools fail — is what makes clients
   refresh. It fails open on a transport error, so an API outage is not a sign-in loop.
4. **Login required for all of `/mcp`**, like Readwise. No bearer → `401` + challenge. This removes
   anonymous use of the three catalog tools over MCP; accepted by the owner. `tsk_` keys and the
   `/mcp/k/<key>` URL (rewritten into a bearer *before* the check) keep working unchanged.
5. **CIMD and DCR both.** CIMD is fetched with an SSRF guard (https, default port, a path, every
   resolved address public — checked in the socket connect callback so DNS rebinding cannot swap it —
   no redirects, 5 s, 16 KB) and cached 24 h in `oauth_clients`. DCR rows land in the same table, so
   authorize resolves both with one lookup. Redirect URIs must be https on an allowlisted host
   (`OAuth:AllowedRedirectHosts`: claude.ai, claude.com, chatgpt.com) or loopback on any port (Claude
   Code); the loopback port is ignored when matching (RFC 8252 §7.3).
6. **Account required to authorize** — a guest's approve is `403 account_required`, the same
   sign-up-vs-sign-in distinction `RequireAiAccount` uses. One scope, `library` ("read and write your
   library"), plus `offline_access`; unknown scopes are dropped, not refused.
7. **Pending requests and codes live in a table**, not `IMemoryCache`: a deploy mid-consent would
   otherwise lose the request, and code single-use is a conditional `UPDATE … WHERE consumed_at IS
   NULL` that wins exactly once. Rows older than a day are swept on each authorize.

## Consequences

- Claude (web, desktop, mobile, Code) and ChatGPT can connect by URL alone; directory submission is
  unblocked on the auth side (tool `title` + `readOnlyHint`/`destructiveHint`/`openWorldHint` were
  added at the same time).
- A `tso_` token is accepted by every API endpoint, as a `tsk_` key is — the bridge reaches the API
  directly, so the API cannot tell a bridged call from a direct one. The practical surface is the 18
  tools; a stolen token is as strong as a stolen key until revoked or, at most, for an hour.
- Refresh-token reuse is refused but does not revoke the grant (no token-family tracking). Revisit if
  a leak is ever suspected.
- nginx must route `/.well-known/oauth-protected-resource[/mcp]` → MCP host and
  `/.well-known/oauth-authorization-server` + `/oauth/` → API; without that they answer the SPA's HTML.
