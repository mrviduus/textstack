using System.Text.Json;
using Api.Extensions;
using Api.Services;
using Application.Auth;
using Application.Common.Interfaces;
using Contracts.Mcp;
using Domain.Entities;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Api.Endpoints;

/// <summary>
/// OAuth 2.1 authorization server for the remote MCP endpoint (ADR-017) — "connect TextStack to
/// Claude/ChatGPT" with a sign-in instead of a pasted key.
///
/// <code>
/// client ─ GET  /.well-known/oauth-authorization-server   metadata (RFC 8414)
///        ─ POST /oauth/register                            DCR (RFC 7591), or a CIMD https client_id
/// browser─ GET  /oauth/authorize                           validate → 302 web /en/oauth/consent?req=
/// SPA    ─ GET  /oauth/requests/{id}                       what to show
///        ─ POST /oauth/authorize/approve | deny            signed-in reader decides → { redirect }
/// client ─ POST /oauth/token                               code+PKCE → tso_/tsr_; refresh rotates
///        ─ POST /oauth/revoke                              RFC 7009
/// reader ─ GET/DELETE /me/oauth/grants                     "Connected apps"
/// </code>
///
/// Public clients only (PKCE S256, no secrets). Tokens are opaque and hashed; <c>McpKeyAuthMiddleware</c>
/// resolves <c>tso_</c> the way it resolves <c>tsk_</c>, plus expiry and audience.
/// </summary>
public static class OAuthEndpoints
{
    public static void MapOAuthEndpoints(this WebApplication app)
    {
        app.MapGet("/.well-known/oauth-authorization-server", Metadata).WithTags("OAuth").ExcludeFromDescription();

        var oauth = app.MapGroup("/oauth").WithTags("OAuth");
        oauth.MapGet("/authorize", Authorize).RequireRateLimiting("oauth-browser");
        oauth.MapGet("/requests/{id:guid}", GetRequest).RequireRateLimiting("oauth-browser");
        oauth.MapPost("/authorize/approve", Approve).RequireRateLimiting("oauth-browser").RejectOAuthTokens();
        oauth.MapPost("/authorize/deny", Deny).RequireRateLimiting("oauth-browser").RejectOAuthTokens();
        oauth.MapPost("/token", Token).RequireRateLimiting("oauth-server");
        oauth.MapPost("/register", Register).RequireRateLimiting("oauth-server");
        oauth.MapPost("/revoke", Revoke).RequireRateLimiting("oauth-server");
        // The MCP host asks this before serving a tso_ bearer, so an expired token gets the 401
        // challenge clients refresh on. No limiter: it arrives from the one bridge address, per
        // MCP request, and costs the lookup McpKeyAuthMiddleware already did.
        oauth.MapGet("/token-status", (HttpContext http, AuthService auth) =>
            http.GetUserId(auth) is null ? Results.Unauthorized() : Results.NoContent()).ExcludeFromDescription();

        var grants = app.MapGroup("/me/oauth/grants").WithTags("OAuth").RejectOAuthTokens();
        grants.MapGet("", ListGrants).WithName("ListOAuthGrants");
        grants.MapDelete("/{id:guid}", RevokeGrant).WithName("RevokeOAuthGrant");
    }

    /// <summary>Issuer = the public site origin. Also the base of every endpoint URL.</summary>
    public static string Issuer(IConfiguration config) =>
        (config["App:BaseUrl"] ?? "https://textstack.app").TrimEnd('/');

    /// <summary>The one protected resource: the MCP endpoint. Tokens are bound to it.</summary>
    public static string Resource(IConfiguration config) => Issuer(config) + "/mcp";

    private static string[] AllowedRedirectHosts(IConfiguration config) =>
        config.GetSection("OAuth:AllowedRedirectHosts").Get<string[]>() is { Length: > 0 } hosts
            ? hosts
            : OAuth.DefaultAllowedRedirectHosts;

    // ── metadata ─────────────────────────────────────────────────────────────────

    private static IResult Metadata(IConfiguration config)
    {
        var issuer = Issuer(config);
        return Results.Json(new Dictionary<string, object>
        {
            ["issuer"] = issuer,
            ["authorization_endpoint"] = $"{issuer}/oauth/authorize",
            ["token_endpoint"] = $"{issuer}/oauth/token",
            ["registration_endpoint"] = $"{issuer}/oauth/register",
            ["revocation_endpoint"] = $"{issuer}/oauth/revoke",
            ["response_types_supported"] = new[] { "code" },
            ["grant_types_supported"] = new[] { "authorization_code", "refresh_token" },
            ["code_challenge_methods_supported"] = new[] { "S256" },
            ["token_endpoint_auth_methods_supported"] = new[] { "none" },
            ["revocation_endpoint_auth_methods_supported"] = new[] { "none" },
            ["scopes_supported"] = OAuth.SupportedScopes,
            ["client_id_metadata_document_supported"] = true,
            ["authorization_response_iss_parameter_supported"] = true,
        });
    }

    // ── authorize ────────────────────────────────────────────────────────────────

    private static async Task<IResult> Authorize(
        HttpContext http, IAppDbContext db, ClientMetadataFetcher fetcher, IConfiguration config, CancellationToken ct)
    {
        var q = http.Request.Query;
        string? P(string key) => q[key].FirstOrDefault() is { Length: > 0 } v ? v : null;

        var (client, clientError) = await ResolveClientAsync(P("client_id"), db, fetcher, ct);
        if (client is null) return Error("invalid_client", clientError);

        // Until redirect_uri is proven, errors go to the browser, never to the URI (RFC 6749 §4.1.2.1).
        var redirectUri = P("redirect_uri");
        if (redirectUri is null
            || !OAuth.RedirectMatches(redirectUri, client.RedirectUris)
            || !OAuth.IsAllowedRedirect(redirectUri, AllowedRedirectHosts(config)))
            return Error("invalid_request", "redirect_uri is not registered for this client or not allowed");

        var issuer = Issuer(config);
        var state = P("state");
        IResult Fail(string error, string description) => Results.Redirect(OAuth.AppendQuery(redirectUri,
            ("error", error), ("error_description", description), ("state", state), ("iss", issuer)));

        if (P("response_type") != "code")
            return Fail("unsupported_response_type", "only response_type=code is supported");
        if (P("code_challenge_method") != "S256" || !OAuth.IsValidCodeChallenge(P("code_challenge")))
            return Fail("invalid_request", "PKCE with code_challenge_method=S256 is required");
        var resource = Resource(config);
        if (!OAuth.ResourceMatches(P("resource"), resource))
            return Fail("invalid_target", $"the only resource is {resource}");

        var now = DateTimeOffset.UtcNow;
        // Sweep: requests live minutes; a day-old row is garbage whatever state it is in.
        await db.OAuthAuthorizationRequests.Where(r => r.CreatedAt < now.AddDays(-1)).ExecuteDeleteAsync(ct);

        var request = new OAuthAuthorizationRequest
        {
            Id = Guid.NewGuid(),
            ClientId = client.ClientId,
            ClientName = client.ClientName,
            RedirectUri = redirectUri,
            State = state,
            CodeChallenge = P("code_challenge")!,
            Resource = resource,
            Scope = OAuth.GrantedScope(P("scope")),
            CreatedAt = now,
            ExpiresAt = now + OAuth.ConsentLifetime,
        };
        db.OAuthAuthorizationRequests.Add(request);
        await db.SaveChangesAsync(ct);

        return Results.Redirect($"{issuer}/en/oauth/consent?req={request.Id}");
    }

    private static async Task<IResult> GetRequest(Guid id, IAppDbContext db, CancellationToken ct)
    {
        var r = await db.OAuthAuthorizationRequests.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id, ct);
        if (r is null) return Results.NotFound();

        return Results.Ok(new OAuthConsentRequestDto(
            r.Id, r.ClientName, r.ClientId, OAuth.DisplayHost(r.RedirectUri), r.Scope,
            OAuth.LibraryScopeDescription, StatusOf(r, DateTimeOffset.UtcNow), r.ExpiresAt));
    }

    private static string StatusOf(OAuthAuthorizationRequest r, DateTimeOffset now) =>
        r.DeniedAt is not null ? "denied"
        : r.UserId is not null ? "approved"
        : r.ExpiresAt <= now ? "expired"
        : "pending";

    private static async Task<IResult> Approve(
        [FromBody] OAuthDecisionRequest body, HttpContext http, AuthService auth, IAppDbContext db,
        IConfiguration config, CancellationToken ct)
    {
        var userId = http.GetUserId(auth);
        if (userId is null) return Results.Unauthorized();

        var user = await auth.GetUserByIdAsync(userId.Value, ct);
        if (user is null) return Results.Unauthorized();

        // Owner decision: connecting an assistant needs a real account. 403 (sign UP), not 401
        // (sign in) — the same distinction and code RequireAiAccount uses.
        if (user.IsGuest)
            return Results.Problem(
                title: "Account required",
                detail: "Create a free account to connect an assistant.",
                statusCode: StatusCodes.Status403Forbidden,
                extensions: new Dictionary<string, object?> { ["error"] = AiAccountPolicy.ErrorCode });

        var r = await db.OAuthAuthorizationRequests.FirstOrDefaultAsync(x => x.Id == body.RequestId, ct);
        if (r is null) return Results.NotFound();

        var now = DateTimeOffset.UtcNow;
        if (StatusOf(r, now) is var status && status != "pending")
            return Results.BadRequest(new { error = $"request_{status}" });

        var code = OAuth.NewToken("");
        r.UserId = userId.Value;
        r.CodeHash = DeviceCodes.HashToken(code);
        r.ExpiresAt = now + OAuth.CodeLifetime;
        await db.SaveChangesAsync(ct);

        return Results.Ok(new OAuthDecisionResponse(OAuth.AppendQuery(r.RedirectUri,
            ("code", code), ("state", r.State), ("iss", Issuer(config)))));
    }

    // No sign-in needed: "Cancel" must reach the client even from a signed-out consent page, and
    // denying a request someone else started is not a capability worth guarding.
    private static async Task<IResult> Deny(
        [FromBody] OAuthDecisionRequest body, IAppDbContext db, IConfiguration config, CancellationToken ct)
    {
        var r = await db.OAuthAuthorizationRequests.FirstOrDefaultAsync(x => x.Id == body.RequestId, ct);
        if (r is null) return Results.NotFound();

        if (StatusOf(r, DateTimeOffset.UtcNow) == "pending")
        {
            r.DeniedAt = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync(ct);
        }

        return Results.Ok(new OAuthDecisionResponse(OAuth.AppendQuery(r.RedirectUri,
            ("error", "access_denied"), ("state", r.State), ("iss", Issuer(config)))));
    }

    // ── token ────────────────────────────────────────────────────────────────────

    private static async Task<IResult> Token(HttpContext http, IAppDbContext db, CancellationToken ct)
    {
        // Form read by hand, not [FromForm]: form binding in minimal APIs switches on antiforgery,
        // which a machine-to-machine token endpoint must not have.
        if (!http.Request.HasFormContentType)
            return Error("invalid_request", "use application/x-www-form-urlencoded");
        var form = await http.Request.ReadFormAsync(ct);
        string? F(string key) => form[key].FirstOrDefault() is { Length: > 0 } v ? v : null;

        http.Response.Headers.CacheControl = "no-store";
        http.Response.Headers.Pragma = "no-cache";

        return F("grant_type") switch
        {
            "authorization_code" => await RedeemCodeAsync(F, db, ct),
            "refresh_token" => await RefreshAsync(F, db, ct),
            _ => Error("unsupported_grant_type", "authorization_code or refresh_token"),
        };
    }

    private static async Task<IResult> RedeemCodeAsync(
        Func<string, string?> f, IAppDbContext db, CancellationToken ct)
    {
        var code = f("code");
        if (code is null) return Error("invalid_request", "code is required");

        var hash = DeviceCodes.HashToken(code);
        var r = await db.OAuthAuthorizationRequests.AsNoTracking().FirstOrDefaultAsync(x => x.CodeHash == hash, ct);
        if (r is null) return Error("invalid_grant", "unknown code");

        // Burn the code FIRST, atomically: one redemption wins, and a failed attempt (bad verifier,
        // wrong redirect) still spends it.
        var now = DateTimeOffset.UtcNow;
        var burned = await db.OAuthAuthorizationRequests
            .Where(x => x.Id == r.Id && x.ConsumedAt == null)
            .ExecuteUpdateAsync(s => s.SetProperty(x => x.ConsumedAt, now), ct);
        if (burned == 0) return Error("invalid_grant", "code already used");

        if (r.UserId is null || r.ExpiresAt <= now) return Error("invalid_grant", "code expired");
        if (f("client_id") != r.ClientId) return Error("invalid_grant", "code was issued to another client");
        if (f("redirect_uri") != r.RedirectUri) return Error("invalid_grant", "redirect_uri does not match");
        if (!OAuth.VerifyPkce(f("code_verifier"), r.CodeChallenge)) return Error("invalid_grant", "PKCE verification failed");
        if (!OAuth.ResourceMatches(f("resource"), r.Resource)) return Error("invalid_target", "resource does not match");

        // One grant per app: reconnecting replaces the previous grant(s) for the same app — matched on
        // (user, client name, redirect host), not client_id, because DCR mints a new client_id on every
        // connect. Revoked in the same SaveChanges as the insert, so the swap is atomic.
        var host = OAuth.DisplayHost(r.RedirectUri);
        var previous = await db.OAuthGrants
            .Where(g => g.UserId == r.UserId.Value && g.ClientName == r.ClientName && g.RevokedAt == null)
            .ToListAsync(ct);
        foreach (var old in previous.Where(g => OAuth.DisplayHost(g.RedirectUri) == host))
            old.RevokedAt = now;

        var access = OAuth.NewToken(OAuth.AccessTokenPrefix);
        var refresh = OAuth.NewToken(OAuth.RefreshTokenPrefix);
        db.OAuthGrants.Add(new OAuthGrant
        {
            Id = Guid.NewGuid(),
            UserId = r.UserId.Value,
            ClientId = r.ClientId,
            ClientName = r.ClientName,
            RedirectUri = r.RedirectUri,
            Resource = r.Resource,
            Scope = r.Scope,
            AccessTokenHash = DeviceCodes.HashToken(access),
            AccessTokenExpiresAt = now + OAuth.AccessTokenLifetime,
            RefreshTokenHash = DeviceCodes.HashToken(refresh),
            RefreshTokenExpiresAt = now + OAuth.RefreshTokenLifetime,
            CreatedAt = now,
        });
        await db.SaveChangesAsync(ct);

        return TokenResponse(access, refresh, r.Scope);
    }

    private static async Task<IResult> RefreshAsync(
        Func<string, string?> f, IAppDbContext db, CancellationToken ct)
    {
        var refresh = f("refresh_token");
        if (refresh is null) return Error("invalid_request", "refresh_token is required");

        var oldHash = DeviceCodes.HashToken(refresh);
        var now = DateTimeOffset.UtcNow;
        var grant = await db.OAuthGrants.AsNoTracking()
            .FirstOrDefaultAsync(g => g.RefreshTokenHash == oldHash && g.RevokedAt == null, ct);

        if (grant is null)
        {
            // An already-rotated refresh token coming back means two parties hold the chain — the
            // standard breach response (RFC 9700 §4.14.2) is to kill the whole grant, both tokens.
            // ponytail: remembers one generation back; an older token is refused but not treated as reuse.
            await db.OAuthGrants
                .Where(g => g.PreviousRefreshTokenHash == oldHash && g.RevokedAt == null)
                .ExecuteUpdateAsync(s => s.SetProperty(g => g.RevokedAt, now), ct);
            return Error("invalid_grant", "refresh token is invalid or expired");
        }
        if (grant.RefreshTokenExpiresAt <= now) return Error("invalid_grant", "refresh token is invalid or expired");
        if (f("client_id") is { } clientId && clientId != grant.ClientId)
            return Error("invalid_grant", "refresh token was issued to another client");
        if (!OAuth.ResourceMatches(f("resource"), grant.Resource)) return Error("invalid_target", "resource does not match");

        var access = OAuth.NewToken(OAuth.AccessTokenPrefix);
        var newRefresh = OAuth.NewToken(OAuth.RefreshTokenPrefix);
        var accessHash = DeviceCodes.HashToken(access);
        var refreshHash = DeviceCodes.HashToken(newRefresh);

        // Conditional on the OLD hash: two concurrent refreshes with one token — exactly one wins.
        var rotated = await db.OAuthGrants
            .Where(g => g.Id == grant.Id && g.RefreshTokenHash == oldHash && g.RevokedAt == null)
            .ExecuteUpdateAsync(s => s
                .SetProperty(g => g.AccessTokenHash, accessHash)
                .SetProperty(g => g.AccessTokenExpiresAt, now + OAuth.AccessTokenLifetime)
                .SetProperty(g => g.PreviousRefreshTokenHash, oldHash)
                .SetProperty(g => g.RefreshTokenHash, refreshHash)
                .SetProperty(g => g.RefreshTokenExpiresAt, now + OAuth.RefreshTokenLifetime)
                .SetProperty(g => g.LastUsedAt, now), ct);
        if (rotated == 0) return Error("invalid_grant", "refresh token is invalid or expired");

        return TokenResponse(access, newRefresh, grant.Scope);
    }

    private static IResult TokenResponse(string access, string refresh, string scope) => Results.Json(new
    {
        access_token = access,
        token_type = "Bearer",
        expires_in = (int)OAuth.AccessTokenLifetime.TotalSeconds,
        refresh_token = refresh,
        scope,
    });

    // ── revoke (RFC 7009) ────────────────────────────────────────────────────────

    private static async Task<IResult> Revoke(HttpContext http, IAppDbContext db, CancellationToken ct)
    {
        if (!http.Request.HasFormContentType)
            return Error("invalid_request", "use application/x-www-form-urlencoded");
        var form = await http.Request.ReadFormAsync(ct);
        var token = form["token"].FirstOrDefault();
        if (string.IsNullOrEmpty(token)) return Error("invalid_request", "token is required");

        // Either token of the pair revokes the whole grant. Unknown tokens are 200 too (§2.2).
        var hash = DeviceCodes.HashToken(token);
        var now = DateTimeOffset.UtcNow;
        await db.OAuthGrants
            .Where(g => (g.AccessTokenHash == hash || g.RefreshTokenHash == hash) && g.RevokedAt == null)
            .ExecuteUpdateAsync(s => s.SetProperty(g => g.RevokedAt, now), ct);
        return Results.Ok();
    }

    // ── register (RFC 7591) ──────────────────────────────────────────────────────

    private const int MaxRedirectUris = 10;
    private const int MaxClientNameLength = 100;

    private static async Task<IResult> Register(HttpContext http, IAppDbContext db, IConfiguration config, CancellationToken ct)
    {
        JsonElement body;
        try
        {
            body = await JsonSerializer.DeserializeAsync<JsonElement>(http.Request.Body, cancellationToken: ct);
        }
        catch (JsonException)
        {
            return Error("invalid_client_metadata", "body must be JSON");
        }
        if (body.ValueKind != JsonValueKind.Object) return Error("invalid_client_metadata", "body must be a JSON object");

        if (!body.TryGetProperty("redirect_uris", out var urisEl) || urisEl.ValueKind != JsonValueKind.Array)
            return Error("invalid_redirect_uri", "redirect_uris is required");
        var uris = urisEl.EnumerateArray().Select(u => u.ValueKind == JsonValueKind.String ? u.GetString()! : "").ToArray();
        var allowed = AllowedRedirectHosts(config);
        if (uris.Length is 0 or > MaxRedirectUris || uris.Any(u => u.Length > 2048 || !OAuth.IsAllowedRedirect(u, allowed)))
            return Error("invalid_redirect_uri", "every redirect_uri must be https on an allowed host, or loopback");

        var name = body.TryGetProperty("client_name", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString()!.Trim() : "";
        if (name.Length == 0) name = "MCP client";
        if (name.Length > MaxClientNameLength) name = name[..MaxClientNameLength];

        // Always registered as a public client, whatever auth method was asked for — RFC 7591 §3.2.1
        // lets the server substitute, and the client must use what comes back.
        var client = new OAuthClient
        {
            Id = Guid.NewGuid(),
            ClientId = OAuth.NewToken(OAuth.ClientIdPrefix),
            ClientName = name,
            RedirectUris = uris,
            CreatedAt = DateTimeOffset.UtcNow,
        };
        db.OAuthClients.Add(client);
        await db.SaveChangesAsync(ct);

        return Results.Json(new
        {
            client_id = client.ClientId,
            client_id_issued_at = client.CreatedAt.ToUnixTimeSeconds(),
            client_name = client.ClientName,
            redirect_uris = client.RedirectUris,
            grant_types = new[] { "authorization_code", "refresh_token" },
            response_types = new[] { "code" },
            token_endpoint_auth_method = "none",
        }, statusCode: StatusCodes.Status201Created);
    }

    // ── client resolution (DCR row or CIMD document) ─────────────────────────────

    private static async Task<(OAuthClient? Client, string? Error)> ResolveClientAsync(
        string? clientId, IAppDbContext db, ClientMetadataFetcher fetcher, CancellationToken ct)
    {
        if (clientId is null) return (null, "client_id is required");

        var row = await db.OAuthClients.FirstOrDefaultAsync(c => c.ClientId == clientId, ct);
        if (!ClientMetadataFetcher.IsMetadataUrl(clientId))
            return row is { IsMetadataDocument: false } ? (row, null) : (null, "unknown client_id");

        var now = DateTimeOffset.UtcNow;
        if (row?.FetchedAt is { } fetched && now - fetched < OAuth.MetadataDocumentCacheLifetime)
            return (row, null);

        var (doc, error) = await fetcher.FetchAsync(clientId, ct);
        if (doc is null) return (null, error);

        if (row is null)
        {
            row = new OAuthClient { Id = Guid.NewGuid(), ClientId = clientId, IsMetadataDocument = true, CreatedAt = now };
            db.OAuthClients.Add(row);
        }
        row.ClientName = doc.ClientName.Length > MaxClientNameLength ? doc.ClientName[..MaxClientNameLength] : doc.ClientName;
        row.RedirectUris = doc.RedirectUris;
        row.FetchedAt = now;
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException)
        {
            // A concurrent first fetch inserted the same client_id. The document in hand is as good.
        }
        return (row, null);
    }

    // ── connected apps ───────────────────────────────────────────────────────────

    private static async Task<IResult> ListGrants(HttpContext http, AuthService auth, IAppDbContext db, CancellationToken ct)
    {
        var userId = http.GetUserId(auth);
        if (userId is null) return Results.Unauthorized();

        var now = DateTimeOffset.UtcNow;
        var rows = await db.OAuthGrants.AsNoTracking()
            .Where(g => g.UserId == userId.Value && g.RevokedAt == null && g.RefreshTokenExpiresAt > now)
            .OrderByDescending(g => g.CreatedAt)
            .ToListAsync(ct);

        return Results.Ok(new
        {
            items = rows.Select(g => new OAuthGrantDto(
                g.Id, g.ClientName, OAuth.DisplayHost(g.RedirectUri), g.CreatedAt, g.LastUsedAt)),
        });
    }

    private static async Task<IResult> RevokeGrant(Guid id, HttpContext http, AuthService auth, IAppDbContext db, CancellationToken ct)
    {
        var userId = http.GetUserId(auth);
        if (userId is null) return Results.Unauthorized();

        var grant = await db.OAuthGrants.FirstOrDefaultAsync(g => g.Id == id && g.UserId == userId.Value, ct);
        if (grant is null) return Results.NotFound();

        if (grant.RevokedAt is null)
        {
            grant.RevokedAt = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync(ct);
        }
        return Results.NoContent();
    }

    private static IResult Error(string error, string? description) =>
        Results.BadRequest(new { error, error_description = description });
}
