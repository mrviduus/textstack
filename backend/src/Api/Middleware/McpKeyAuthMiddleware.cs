using Api.Extensions;
using Application.Auth;
using Application.Common.Interfaces;
using Microsoft.EntityFrameworkCore;

namespace Api.Middleware;

/// <summary>
/// Resolves an <c>Authorization: Bearer tsk_…</c> connect key to a user id and stashes it on
/// <see cref="HttpContext.Items"/>, where <see cref="ClaimsPrincipalExtensions.GetUserId"/> reads it
/// before falling back to JWT validation.
///
/// <para><b>Why middleware and not the extension method.</b> <c>GetUserId</c> is synchronous and
/// called from 102 places. Validating a key needs a database round-trip, so making it async would
/// mean touching every one of those call sites. Resolving once per request instead keeps the
/// signature and does the lookup exactly once even for an endpoint that asks twice.</para>
///
/// <para><b>Ordinary traffic pays a prefix check.</b> The database is touched only when the bearer
/// actually starts with <see cref="McpKeys.Prefix"/>. A JWT cannot start with it, so every request
/// from the web and mobile clients exits at the first branch.</para>
///
/// <para><b>Why this sits ABOVE the rate limiter, unlike <see cref="GuestActivityMiddleware"/>.</b>
/// That one is deliberately below, so a rejected request costs no database work. This one cannot be:
/// the <c>highlight-write</c> policy is the only limiter partitioned by user id rather than IP, and
/// it is partitioned that way precisely because MCP traffic arrives from one container address — key
/// resolution has to have happened before the limiter picks a partition, or every MCP user shares a
/// bucket and one looping client throttles all of them. The cost of that choice is a single indexed
/// lookup on requests that carry a key-shaped bearer.</para>
///
/// <para><b>It never rejects.</b> An unknown, revoked or malformed key leaves
/// <see cref="HttpContext.Items"/> untouched and the request continues unauthenticated, so the
/// endpoint returns its own 401 in its own shape. Middleware that short-circuits with its own error
/// body would give MCP a different failure envelope than every other caller.</para>
/// </summary>
public sealed class McpKeyAuthMiddleware(RequestDelegate next)
{
    /// <summary>Key on <see cref="HttpContext.Items"/>. Internal contract with <c>GetUserId</c>.</summary>
    public const string UserIdItemKey = "mcp_key_user_id";

    public async Task InvokeAsync(HttpContext context, IAppDbContext db)
    {
        var token = context.GetAccessToken();
        if (!McpKeys.LooksLikeKey(token))
        {
            await next(context);
            return;
        }

        var hash = DeviceCodes.HashToken(token!);

        // Revocation is checked in the same query as the lookup — a revoked key must stop
        // authenticating the moment it is revoked, with no cached decision in between.
        var key = await db.McpAccessKeys
            .FirstOrDefaultAsync(k => k.KeyHash == hash && k.RevokedAt == null, context.RequestAborted);

        if (key is not null)
        {
            context.Items[UserIdItemKey] = key.UserId;

            // Throttled: an assistant makes one request per tool call. Writing this per request
            // would put an UPDATE in front of every read of the user's own library.
            var now = DateTimeOffset.UtcNow;
            if (key.LastUsedAt is null || now - key.LastUsedAt.Value >= McpKeys.LastUsedWriteInterval)
            {
                key.LastUsedAt = now;
                await db.SaveChangesAsync(context.RequestAborted);
            }
        }

        await next(context);
    }
}
