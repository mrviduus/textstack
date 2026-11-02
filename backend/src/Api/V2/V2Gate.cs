using System.Globalization;
using Api.Middleware;
using Application.Auth;
using Application.Identity;
using Application.Sync;
using Contracts.V2;

namespace Api.V2;

/// <summary>
/// The endpoint filter on every <c>/me/v2</c> route: V2 not ready → 503 <c>v2_unavailable</c> with
/// <c>Retry-After</c>, so sync pauses while sign-in, the legacy library and the catalog keep serving
/// (#1053); then the session's legacy account, read every request as every other <c>/me</c> endpoint
/// does (none → 401), and its V2 shadow row (<see cref="V2ShadowUsers"/>, M2.2's bridge). Only
/// <see cref="V2Readiness"/> is injected: anything that reaches a V2 repository is resolved after the
/// check, since resolving one without <c>ConnectionStrings:V2</c> throws.
/// </summary>
public sealed class V2Gate(V2Readiness readiness) : IEndpointFilter
{
    private static readonly string RetryAfterSeconds = ((int)V2Readiness.Ttl.TotalSeconds).ToString(CultureInfo.InvariantCulture);

    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var http = context.HttpContext;
        if (!(await readiness.GetAsync()).IsReady) return Unavailable(http, "Sync is paused; reading is unaffected.");

        var legacy = await http.RequestServices.GetRequiredService<AuthService>().GetUserByIdAsync(PathGates.UserOf(http), http.RequestAborted);
        if (legacy is null) return Results.Unauthorized();
        if (await http.RequestServices.GetRequiredService<V2ShadowUsers>().EnsureAsync(legacy, http.RequestAborted) == ShadowOutcome.EmailHeld)
            return Unavailable(http, "Sync is not available for this account yet.");
        return await next(context);
    }

    private static IResult Unavailable(HttpContext http, string message)
    {
        http.Response.Headers.RetryAfter = RetryAfterSeconds;
        return Results.Json(new V2Error(SyncCodes.V2Unavailable, message), statusCode: StatusCodes.Status503ServiceUnavailable);
    }
}
