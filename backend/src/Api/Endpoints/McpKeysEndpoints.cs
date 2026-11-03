using Api.Extensions;
using Application.Auth;
using Application.Identity;
using Contracts.Mcp;
using Microsoft.AspNetCore.Mvc;

namespace Api.Endpoints;

/// <summary>
/// The connect keys a reader manages for their AI client — create, list, revoke.
///
/// <para>This is the whole onboarding story for the remote MCP endpoint. Before it, connecting Claude
/// or ChatGPT meant installing a .NET CLI, running a device flow in a terminal, copying a JWT out of
/// a cache file, and doing it again within the hour when the 60-minute access token expired. Nobody
/// who is not sitting at a terminal could do that, and nobody at all could do it from a phone —
/// which is the real explanation for zero insights, not the quality of the feature.</para>
///
/// <para>The device flow is untouched and still correct for the local stdio tool, which caches a
/// refresh token and renews on its own. This exists for the transport that cannot.</para>
/// </summary>
public static class McpKeysEndpoints
{
    public static void MapMcpKeysEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/me/mcp/keys").WithTags("MCP Keys").RejectOAuthTokens();

        group.MapGet("", ListKeys).WithName("ListMcpKeys");
        group.MapPost("", CreateKey).WithName("CreateMcpKey").RequireRateLimiting("mcp-keys");
        group.MapDelete("/{id:guid}", RevokeKey).WithName("RevokeMcpKey");
    }

    private static async Task<IResult> ListKeys(
        HttpContext httpContext,
        IAuthService authService,
        IMcpKeyRepository keys,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        // Revoked keys are listed too, marked as such. A key that vanishes when you revoke it gives
        // no confirmation that the right one went; the row is also the record that it happened.
        var items = (await keys.ListAsync(userId.Value, ct))
            .Select(k => new McpKeyDto(k.Id, k.Name, k.Prefix, k.CreatedAt, k.LastUsedAt, k.RevokedAt));

        return Results.Ok(new { items });
    }

    private static async Task<IResult> CreateKey(
        [FromBody] CreateMcpKeyRequest request,
        HttpContext httpContext,
        IAuthService authService,
        IMcpKeyRepository keys,
        CancellationToken ct)
    {
        var identity = httpContext.GetAccessTokenIdentity(authService);
        if (identity == null) return Results.Unauthorized();

        if (await keys.CountLiveAsync(identity.UserId, ct) >= McpKeys.MaxKeysPerUser)
            return Results.BadRequest(new
            {
                error = $"You already have {McpKeys.MaxKeysPerUser} active keys. Revoke one first.",
            });

        var raw = McpKeys.Generate();

        var key = await keys.CreateAsync(identity.UserId, McpKeys.NormalizeName(request.Name),
            DeviceCodes.HashToken(raw), McpKeys.DisplayPrefix(raw), identity.IssuedAt, ct);
        // The account is gone, or (V2) its password was reset after this token was issued: sign in again.
        if (key is null) return Results.Unauthorized();

        // `key` is returned here and nowhere else, ever — only its hash is kept. The client must show
        // it once and tell the reader so.
        return Results.Ok(new CreateMcpKeyResponse(
            key.Id, key.Name, raw, key.Prefix, key.CreatedAt));
    }

    private static async Task<IResult> RevokeKey(
        Guid id,
        HttpContext httpContext,
        IAuthService authService,
        IMcpKeyRepository keys,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        // Idempotent: revoking an already-revoked key keeps the original timestamp, so the audit
        // answer stays "when was this turned off" rather than "when was it last clicked".
        return await keys.RevokeAsync(userId.Value, id, ct) ? Results.NoContent() : Results.NotFound();
    }
}
