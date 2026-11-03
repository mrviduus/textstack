using Application.Auth;
using Application.Entitlements;

namespace Api.Extensions;

/// <summary>
/// "This capability needs a real account." One policy, applied at the route, rather than an
/// <c>if (user.IsGuest)</c> copied into a dozen handlers.
/// </summary>
/// <remarks>
/// The product decides who may use AI in exactly one place — <c>Entitlements:Tiers:*:AiEnabled</c>,
/// resolved through <see cref="IEntitlementResolver"/>. This filter is only the enforcement point.
///
/// It exists because the mobile client's <c>canUseAi = isAccount</c> is a UI affordance and not a
/// boundary: a guest session mints a perfectly valid bearer token, so before this every paid-inference
/// endpoint answered a guest with a real LLM call and an IP rate limit as its only barrier. Deliberately
/// NOT applied to translate, dictionary or TTS — those are anonymous on purpose and the reading loop
/// depends on them.
/// </remarks>
public static class AiAccountPolicy
{
    /// <summary>Machine-readable code clients branch on to show "create a free account".</summary>
    public const string ErrorCode = "account_required";

    /// <summary>
    /// 403 <see cref="ErrorCode"/> for a guest connecting an assistant (OAuth consent, MCP connect keys):
    /// a persistent assistant credential needs a real account (#1120).
    /// </summary>
    public static IResult AssistantAccountRequired() => Results.Problem(
        title: "Account required",
        detail: "Create a free account to connect an assistant.",
        statusCode: StatusCodes.Status403Forbidden,
        extensions: new Dictionary<string, object?> { ["error"] = ErrorCode });

    /// <summary>
    /// Rejects callers whose tier has AI switched off, before the handler runs (and therefore before
    /// any token is spent). 401 when unauthenticated, 403 when authenticated but not entitled —
    /// the distinction matters to the client: one means "sign in", the other "sign UP".
    /// </summary>
    public static TBuilder RequireAiAccount<TBuilder>(this TBuilder builder)
        where TBuilder : IEndpointConventionBuilder
        => builder.AddEndpointFilter<TBuilder, AiAccountEndpointFilter>();
}

internal sealed class AiAccountEndpointFilter : IEndpointFilter
{
    public async ValueTask<object?> InvokeAsync(
        EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var http = context.HttpContext;

        // Resolved per request, not injected: AuthService is scoped and the filter instance is not.
        var authService = http.RequestServices.GetRequiredService<AuthService>();

        var userId = http.GetUserId(authService);
        if (userId is null) return Results.Unauthorized();

        var user = await authService.GetUserByIdAsync(userId.Value, http.RequestAborted);
        if (user is null) return Results.Unauthorized();

        var entitlements = http.RequestServices.GetRequiredService<IEntitlementResolver>();
        if (!entitlements.Resolve(user).CanUseAi)
        {
            return Results.Problem(
                title: "Account required",
                detail: "Create a free account to use AI features.",
                statusCode: StatusCodes.Status403Forbidden,
                extensions: new Dictionary<string, object?> { ["error"] = AiAccountPolicy.ErrorCode });
        }

        return await next(context);
    }
}
