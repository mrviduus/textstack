using System.Globalization;
using Api.Extensions;
using Application.Auth;
using Application.Common;
using Application.Common.Interfaces;
using Application.Identity;
using Application.Sync;
using Npgsql;

namespace Api.V2;

/// <summary>
/// The endpoint filter on every <c>/me/v2</c> route (PathGates has already answered 401 without a user):
/// <list type="number">
/// <item>V2 not ready → 503 <c>v2_unavailable</c> with <c>Retry-After</c>: sync pauses while sign-in, the
/// legacy library and the catalog keep serving (#1053).</item>
/// <item>The session's legacy account, every request; none → 401. Legacy <c>/me</c> endpoints do not
/// check this, because a deleted account's rows went with it and its token reaches nothing; here the
/// token would create new V2 rows under the deleted account.</item>
/// <item>Its V2 shadow row (<see cref="V2ShadowUsers"/>, M2.2's bridge); an email held by another V2
/// account → 503.</item>
/// </list>
/// A V2 error under a handler drops the readiness cache, so the next request sees an outage at once
/// rather than after its TTL; a users FK violation is 401 instead and drops the shadow entry (the row
/// is gone: a guest merged or an account deleted mid-request).
/// </summary>
public sealed class V2Gate(V2Readiness readiness, V2ShadowUsers shadows, IAppDbContext legacy, AuthService auth) : IEndpointFilter
{
    private static readonly string RetryAfterSeconds = ((int)V2Readiness.Ttl.TotalSeconds).ToString(CultureInfo.InvariantCulture);

    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var http = context.HttpContext;
        if (!(await readiness.GetAsync()).IsReady) return Unavailable(http);

        var userId = http.GetUserId(auth)!.Value;
        if (!await V2ShadowUsers.HasLegacyAccountAsync(legacy, userId, http.RequestAborted)) return Results.Unauthorized();
        if (!await shadows.EnsureAsync(legacy, userId, http.RequestAborted)) return Unavailable(http);
        try
        {
            return await next(context);
        }
        // A write in flight when its user vanished (a guest merged into an account, an account deleted):
        // the users FK refuses it, and the session's user no longer exists. The legacy check above
        // answers every later request; this is the one that raced it.
        catch (PostgresException e) when (e.IsForeignKeyViolation() && e.ConstraintName?.EndsWith("_users_user_id", StringComparison.Ordinal) == true)
        {
            shadows.Forget(userId);
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
        return Results.Json(SyncResult.V2Unavailable.Body, statusCode: SyncResult.V2Unavailable.Status);
    }
}
