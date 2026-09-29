namespace Api.Extensions;

/// <summary>
/// "An OAuth access token cannot do this." A <c>tso_</c> token is granted one permission — read and
/// write the library (ADR-017) — so account management is off limits to it: deleting the account,
/// identity/profile, sign-in/sessions, connect keys, OAuth grants, and approving further device or
/// OAuth requests (which would let a token mint a broader credential).
///
/// <para>Applied to whole route GROUPS, so a new endpoint added to one of them is covered without
/// anyone remembering. Web/mobile JWTs and <c>tsk_</c> keys are unaffected.</para>
/// </summary>
public static class OAuthTokenPolicy
{
    public static TBuilder RejectOAuthTokens<TBuilder>(this TBuilder builder)
        where TBuilder : IEndpointConventionBuilder
        => builder.AddEndpointFilter<TBuilder, RejectOAuthTokenFilter>();
}

internal sealed class RejectOAuthTokenFilter : IEndpointFilter
{
    public ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var http = context.HttpContext;
        if (!http.Items.ContainsKey(Middleware.McpKeyAuthMiddleware.OAuthTokenItemKey))
            return next(context);

        http.Response.Headers.WWWAuthenticate = "Bearer error=\"insufficient_scope\", scope=\"account\"";
        return ValueTask.FromResult<object?>(Results.Json(
            new { error = "insufficient_scope", error_description = "An assistant's access token cannot manage the account." },
            statusCode: StatusCodes.Status403Forbidden));
    }
}
