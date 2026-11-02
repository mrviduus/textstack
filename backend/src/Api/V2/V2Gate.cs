using System.Globalization;
using Api.Extensions;
using Application.Auth;
using Application.Identity;
using Application.Sync;
using Contracts.V2;

namespace Api.V2;

/// <summary>
/// The endpoint filter on every <c>/me/v2</c> route: V2 not ready → 503 <c>v2_unavailable</c> with
/// <c>Retry-After</c>, so sync pauses while sign-in, the legacy library and the catalog keep serving
/// (#1053); then the session user's V2 shadow row (<see cref="V2ShadowUsers"/>, M2.2's bridge).
/// PathGates has already answered 401 to a request without a user. Only <see cref="V2Readiness"/> is
/// injected: anything that reaches a V2 repository is resolved after the check, since resolving one
/// without <c>ConnectionStrings:V2</c> throws.
/// </summary>
public sealed class V2Gate(V2Readiness readiness) : IEndpointFilter
{
    private const string UserIdKey = "V2.UserId";
    private static readonly string RetryAfterSeconds = ((int)V2Readiness.Ttl.TotalSeconds).ToString(CultureInfo.InvariantCulture);

    /// <summary>The session user, as the gate resolved it.</summary>
    public static Guid UserOf(HttpContext http) => (Guid)http.Items[UserIdKey]!;

    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var http = context.HttpContext;
        if (!(await readiness.GetAsync()).IsReady) return Unavailable(http, "Sync is paused; reading is unaffected.");

        var auth = http.RequestServices.GetRequiredService<AuthService>();
        var userId = http.GetUserId(auth)!.Value;
        var shadow = await http.RequestServices.GetRequiredService<V2ShadowUsers>()
            .EnsureAsync(userId, () => auth.GetUserByIdAsync(userId, http.RequestAborted), http.RequestAborted);
        if (shadow == ShadowOutcome.NoAccount) return Results.Unauthorized();
        if (shadow == ShadowOutcome.EmailHeld) return Unavailable(http, "Sync is not available for this account yet.");

        http.Items[UserIdKey] = userId;
        return await next(context);
    }

    private static IResult Unavailable(HttpContext http, string message)
    {
        http.Response.Headers.RetryAfter = RetryAfterSeconds;
        return Results.Json(new V2Error(SyncCodes.V2Unavailable, message), statusCode: StatusCodes.Status503ServiceUnavailable);
    }
}
