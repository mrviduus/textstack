using Api.Extensions;
using Api.Sites;
using Application.Auth;
using Application.Common.Interfaces;
using Contracts.Mcp;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

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
        var group = app.MapGroup("/me/mcp/keys").WithTags("MCP Keys");

        group.MapGet("", ListKeys).WithName("ListMcpKeys");
        group.MapPost("", CreateKey).WithName("CreateMcpKey").RequireRateLimiting("mcp-keys");
        group.MapDelete("/{id:guid}", RevokeKey).WithName("RevokeMcpKey");
    }

    private static async Task<IResult> ListKeys(
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        // Revoked keys are listed too, marked as such. A key that vanishes when you revoke it gives
        // no confirmation that the right one went; the row is also the record that it happened.
        var keys = await db.McpAccessKeys
            .Where(k => k.UserId == userId.Value)
            .OrderByDescending(k => k.CreatedAt)
            .Select(k => new McpKeyDto(
                k.Id, k.Name, k.Prefix, k.CreatedAt, k.LastUsedAt, k.RevokedAt))
            .ToListAsync(ct);

        return Results.Ok(new { items = keys });
    }

    private static async Task<IResult> CreateKey(
        [FromBody] CreateMcpKeyRequest request,
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var liveCount = await db.McpAccessKeys
            .CountAsync(k => k.UserId == userId.Value && k.RevokedAt == null, ct);

        if (liveCount >= McpKeys.MaxKeysPerUser)
            return Results.BadRequest(new
            {
                error = $"You already have {McpKeys.MaxKeysPerUser} active keys. Revoke one first.",
            });

        var raw = McpKeys.Generate();

        var key = new Domain.Entities.McpAccessKey
        {
            Id = Guid.NewGuid(),
            UserId = userId.Value,
            SiteId = httpContext.GetSiteId(),
            Name = McpKeys.NormalizeName(request.Name),
            KeyHash = DeviceCodes.HashToken(raw),
            Prefix = McpKeys.DisplayPrefix(raw),
            CreatedAt = DateTimeOffset.UtcNow,
        };

        db.McpAccessKeys.Add(key);
        await db.SaveChangesAsync(ct);

        // `key` is returned here and nowhere else, ever — only its hash is kept. The client must show
        // it once and tell the reader so.
        return Results.Ok(new CreateMcpKeyResponse(
            key.Id, key.Name, raw, key.Prefix, key.CreatedAt));
    }

    private static async Task<IResult> RevokeKey(
        Guid id,
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var key = await db.McpAccessKeys
            .FirstOrDefaultAsync(k => k.Id == id && k.UserId == userId.Value, ct);

        if (key is null) return Results.NotFound();

        // Idempotent: revoking an already-revoked key keeps the original timestamp, so the audit
        // answer stays "when was this turned off" rather than "when was it last clicked".
        if (key.RevokedAt is null)
        {
            key.RevokedAt = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync(ct);
        }

        return Results.NoContent();
    }
}
