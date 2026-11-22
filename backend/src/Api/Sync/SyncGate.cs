using System.Globalization;
using Api.Extensions;
using Application.Identity;
using Application.Common;
using Application.Sync;
using Npgsql;
using Domain.Identity;

namespace Api.Sync;

/// <summary>
/// The endpoint filter on every <c>/me/v2</c> route (PathGates has already answered 401 without a user):
/// <list type="number">
/// <item>V2 not ready → 503 <c>v2_unavailable</c> with <c>Retry-After</c>: sync pauses while sign-in keeps
/// serving (#1053).</item>
/// <item>The session's account is required (<see cref="Middleware.AccountGuard"/> has read it); none → 401:
/// the token would otherwise create rows under a deleted account.</item>
/// </list>
/// A V2 error under a handler drops the readiness cache, so the next request sees an outage at once
/// rather than after its TTL; a users FK violation is 401 instead (the row is gone: a guest merged or an
/// account deleted mid-request).
/// </summary>
public sealed class SyncGate(SyncReadiness readiness, IAuthService auth, IUserRepository users) : IEndpointFilter
{
    private static readonly string RetryAfterSeconds = ((int)SyncReadiness.Ttl.TotalSeconds).ToString(CultureInfo.InvariantCulture);

    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var http = context.HttpContext;
        if (!(await readiness.GetAsync()).IsReady) return Unavailable(http);

        var userId = http.GetUserId(auth)!.Value;
        try
        {
            var account = http.Items.TryGetValue(Middleware.AccountGuard.AccountItemKey, out var cached)
                ? cached as UserAccount : await users.GetAsync(userId, http.RequestAborted);
            if (account is null) return Results.Unauthorized();
            return await next(context);
        }
        // A write in flight when its user vanished (a guest merged into an account, an account deleted):
        // the users FK refuses it, and the session's user no longer exists.
        catch (PostgresException e) when (e.IsForeignKeyViolation() && e.ConstraintName?.EndsWith("_users_user_id", StringComparison.Ordinal) == true)
        {
            return Results.Unauthorized();
        }
        catch (NpgsqlException e)
        {
            readiness.Observe(e);
            throw;
        }
    }

    private static IResult Unavailable(HttpContext http)
    {
        http.Response.Headers.RetryAfter = RetryAfterSeconds;
        return Results.Json(SyncResult.Unavailable.Body, statusCode: SyncResult.Unavailable.Status);
    }
}
