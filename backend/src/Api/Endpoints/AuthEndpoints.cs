using Application.Auth;
using Microsoft.AspNetCore.Mvc;

namespace Api.Endpoints;

public static class AuthEndpoints
{
    private const string AccessTokenCookie = "access_token";
    private const string RefreshTokenCookie = "refresh_token";

    public static void MapAuthEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/auth").WithTags("Auth");

        group.MapPost("/google", LoginWithGoogle).WithName("LoginWithGoogle");
        group.MapPost("/refresh", RefreshToken).WithName("RefreshToken");
        group.MapPost("/logout", Logout).WithName("Logout");
        group.MapGet("/me", GetCurrentUser).WithName("GetCurrentUser");
    }

    private static async Task<IResult> LoginWithGoogle(
        [FromBody] GoogleLoginRequest request,
        AuthService authService,
        HttpContext httpContext,
        CancellationToken ct)
    {
        var result = await authService.LoginWithGoogleAsync(request.IdToken, ct);

        if (result == null)
            return Results.Unauthorized();

        var (user, accessToken, refreshToken) = result.Value;

        SetAuthCookies(httpContext, accessToken, refreshToken);

        return Results.Ok(new AuthResponse(new UserDto(user.Id, user.Email, user.Name, user.Picture, user.CreatedAt)));
    }

    private static async Task<IResult> RefreshToken(
        AuthService authService,
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

        return Results.Ok(new AuthResponse(new UserDto(user.Id, user.Email, user.Name, user.Picture, user.CreatedAt)));
    }

    private static async Task<IResult> Logout(
        AuthService authService,
        HttpContext httpContext,
        CancellationToken ct)
    {
        var refreshToken = httpContext.Request.Cookies[RefreshTokenCookie];

        if (!string.IsNullOrEmpty(refreshToken))
            await authService.LogoutAsync(refreshToken, ct);

        ClearAuthCookies(httpContext);

        return Results.Ok();
    }

    private static async Task<IResult> GetCurrentUser(
        AuthService authService,
        HttpContext httpContext,
        CancellationToken ct)
    {
        var accessToken = httpContext.Request.Cookies[AccessTokenCookie];

        if (string.IsNullOrEmpty(accessToken))
            return Results.Unauthorized();

        var userId = authService.ValidateAccessToken(accessToken);

        if (userId == null)
            return Results.Unauthorized();

        var user = await authService.GetUserByIdAsync(userId.Value, ct);

        if (user == null)
            return Results.Unauthorized();

        return Results.Ok(new AuthResponse(new UserDto(user.Id, user.Email, user.Name, user.Picture, user.CreatedAt)));
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
