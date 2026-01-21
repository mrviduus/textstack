using Application.AdminAuth;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;

namespace Api.Endpoints;

public static class AdminAuthEndpoints
{
    private const string AccessTokenCookie = "admin_access_token";
    private const string RefreshTokenCookie = "admin_refresh_token";

    public static void MapAdminAuthEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/admin/auth").WithTags("AdminAuth");

        group.MapPost("/login", Login)
            .WithName("AdminLogin")
            .RequireRateLimiting("admin-login");
        group.MapPost("/refresh", RefreshToken).WithName("AdminRefreshToken");
        group.MapPost("/logout", Logout).WithName("AdminLogout");
        group.MapGet("/me", GetCurrentAdmin).WithName("GetCurrentAdmin");
    }

    private static async Task<IResult> Login(
        [FromBody] AdminLoginRequest request,
        AdminAuthService authService,
        HttpContext httpContext,
        CancellationToken ct)
    {
        var result = await authService.LoginAsync(request.Email, request.Password, ct);

        if (result == null)
            return Results.Unauthorized();

        var (user, accessToken, refreshToken) = result.Value;

        SetAuthCookies(httpContext, accessToken, refreshToken);

        return Results.Ok(new AdminAuthResponse(
            new AdminUserDto(user.Id, user.Email, user.Role, user.CreatedAt)));
    }

    private static async Task<IResult> RefreshToken(
        AdminAuthService authService,
        HttpContext httpContext,
        CancellationToken ct)
    {
        var refreshToken = httpContext.Request.Cookies[RefreshTokenCookie];

        if (string.IsNullOrEmpty(refreshToken))
            return Results.Unauthorized();

        var result = await authService.RefreshTokenAsync(refreshToken, ct);

        if (result == null)
        {
            ClearAuthCookies(httpContext);
            return Results.Unauthorized();
        }

        var (user, newAccessToken, newRefreshToken) = result.Value;

        SetAuthCookies(httpContext, newAccessToken, newRefreshToken);

        return Results.Ok(new AdminAuthResponse(
            new AdminUserDto(user.Id, user.Email, user.Role, user.CreatedAt)));
    }

    private static async Task<IResult> Logout(
        AdminAuthService authService,
        HttpContext httpContext,
        CancellationToken ct)
    {
        var refreshToken = httpContext.Request.Cookies[RefreshTokenCookie];

        if (!string.IsNullOrEmpty(refreshToken))
            await authService.LogoutAsync(refreshToken, ct);

        ClearAuthCookies(httpContext);

        return Results.Ok();
    }

    private static async Task<IResult> GetCurrentAdmin(
        AdminAuthService authService,
        HttpContext httpContext,
        CancellationToken ct)
    {
        var accessToken = httpContext.Request.Cookies[AccessTokenCookie];

        if (string.IsNullOrEmpty(accessToken))
            return Results.Unauthorized();

        var (adminId, _) = authService.ValidateAccessToken(accessToken);

        if (adminId == null)
            return Results.Unauthorized();

        var user = await authService.GetAdminByIdAsync(adminId.Value, ct);

        if (user == null)
            return Results.Unauthorized();

        return Results.Ok(new AdminAuthResponse(
            new AdminUserDto(user.Id, user.Email, user.Role, user.CreatedAt)));
    }

    private static void SetAuthCookies(HttpContext httpContext, string accessToken, string refreshToken)
    {
        var isProduction = !httpContext.RequestServices
            .GetRequiredService<IWebHostEnvironment>()
            .IsDevelopment();

        httpContext.Response.Cookies.Append(AccessTokenCookie, accessToken, new CookieOptions
        {
            HttpOnly = true,
            Secure = isProduction,
            SameSite = SameSiteMode.Lax,
            MaxAge = TimeSpan.FromMinutes(15),
            Path = "/"
        });

        httpContext.Response.Cookies.Append(RefreshTokenCookie, refreshToken, new CookieOptions
        {
            HttpOnly = true,
            Secure = isProduction,
            SameSite = SameSiteMode.Lax,
            MaxAge = TimeSpan.FromDays(30),
            Path = "/"
        });
    }

    private static void ClearAuthCookies(HttpContext httpContext)
    {
        httpContext.Response.Cookies.Delete(AccessTokenCookie);
        httpContext.Response.Cookies.Delete(RefreshTokenCookie);
    }
}
