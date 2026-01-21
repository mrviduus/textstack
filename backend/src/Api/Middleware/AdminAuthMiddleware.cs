using Application.AdminAuth;
using Domain.Enums;

namespace Api.Middleware;

public class AdminAuthMiddleware(RequestDelegate next)
{
    private const string AccessTokenCookie = "admin_access_token";

    public async Task InvokeAsync(HttpContext context, AdminAuthService authService)
    {
        var accessToken = context.Request.Cookies[AccessTokenCookie];

        if (string.IsNullOrEmpty(accessToken))
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return;
        }

        var (adminId, role) = authService.ValidateAccessToken(accessToken);

        if (adminId == null)
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return;
        }

        // Store admin info in HttpContext.Items for use in endpoints
        context.Items["AdminUserId"] = adminId.Value;
        if (role.HasValue)
            context.Items["AdminRole"] = role.Value;

        await next(context);
    }
}

public static class AdminAuthMiddlewareExtensions
{
    public static IApplicationBuilder UseAdminAuth(this IApplicationBuilder app)
        => app.UseMiddleware<AdminAuthMiddleware>();
}

// Extension methods to get admin info from HttpContext
public static class AdminContextExtensions
{
    public static Guid? GetAdminUserId(this HttpContext context)
        => context.Items.TryGetValue("AdminUserId", out var id) ? (Guid)id! : null;

    public static AdminRole? GetAdminRole(this HttpContext context)
        => context.Items.TryGetValue("AdminRole", out var role) ? (AdminRole)role! : null;
}
