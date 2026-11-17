using System.Globalization;
using Api.Extensions;
using Application.Auth;
using Application.Common;
using Application.Common.Interfaces;
using Application.Identity;
using Application.Sync;
using Npgsql;
using Infrastructure.Persistence;
using Domain.Identity;

namespace Api.V2;

/// <summary>
/// The endpoint filter on every <c>/me/v2</c> route (PathGates has already answered 401 without a user):
/// <list type="number">
/// <item>V2 not ready → 503 <c>v2_unavailable</c> with <c>Retry-After</c>: sync pauses while sign-in, the
/// legacy library and the catalog keep serving (#1053).</item>
/// <item>In V2 identity mode, the current V2 account is required; no legacy lookup or shadow creation.
/// Otherwise the session's legacy account is checked every request; none → 401. Legacy <c>/me</c> endpoints do not
/// check this, because a deleted account's rows went with it and its token reaches nothing; here the
/// token would create new V2 rows under the deleted account.</item>
/// <item>In legacy mode, its V2 shadow row (<see cref="V2ShadowUsers"/>, M2.2's bridge); an email held by another V2
/// account → 503.</item>
/// </list>
/// A V2 error under a handler drops the readiness cache, so the next request sees an outage at once
/// rather than after its TTL; a users FK violation is 401 instead and drops the shadow entry (the row
/// is gone: a guest merged or an account deleted mid-request).
/// </summary>
public sealed class V2Gate(V2Readiness readiness, V2ShadowUsers shadows, IAppDbContext legacy, IAuthService auth, IConfiguration configuration, IUserRepository users, DatabaseMode mode) : IEndpointFilter
{
    private static readonly string RetryAfterSeconds = ((int)V2Readiness.Ttl.TotalSeconds).ToString(CultureInfo.InvariantCulture);

    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var http = context.HttpContext;
        if (!(await readiness.GetAsync()).IsReady) return Unavailable(http);

        var userId = http.GetUserId(auth)!.Value;
        // The legacy read stays outside the try: a legacy outage must not drop V2 readiness.
        UserAccount? legacyAccount = null;
        if (!mode.IsV2 && (legacyAccount = await V2ShadowUsers.GetLegacyAccountAsync(legacy, userId, http.RequestAborted)) is null)
            return Results.Unauthorized();
        try
        {
            if (legacyAccount is not null)
            {
                if (!await shadows.EnsureAsync(legacyAccount, http.RequestAborted,
                    readOnly: configuration.GetValue<bool>(Middleware.WriteFreezeMiddleware.ConfigurationKey))) return Unavailable(http);
            }
            else
            {
                var account = http.Items.TryGetValue(Middleware.SelectedDatabaseGuard.AccountItemKey, out var cached)
                    ? cached as UserAccount : await users.GetAsync(userId, http.RequestAborted);
                if (account is null) return Results.Unauthorized();
            }
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
