using Api.Extensions;
using Application.Identity;
using Application.Sync;
using Domain.Identity;
using Npgsql;

namespace Api.Middleware;

/// <summary>Never accepts a reset or deleted account's JWT: the account is read from V2 per session request.</summary>
public sealed class AccountGuard(RequestDelegate next)
{
    public static readonly object AccountItemKey = new();

    public async Task InvokeAsync(HttpContext http, IAuthService auth, IUserRepository users)
    {
        if (HttpMethods.IsOptions(http.Request.Method))
        {
            await next(http);
            return;
        }

        var path = http.Request.Path;
        try
        {
            if (IsAdminSessionPath(path))
            {
                var raw = http.Request.Cookies["admin_access_token"];
                var token = raw is null ? null : http.RequestServices.GetRequiredService<JwtTokens>().ValidateAdminAccessTokenIdentity(raw);
                if (token is not null)
                {
                    var account = await users.GetAsync(token.AdminId, http.RequestAborted);
                    if (account?.Role != UserAccount.AdminRole || ResetAfter(account, token.IssuedAt))
                    {
                        http.Response.StatusCode = 401;
                        return;
                    }
                }
            }
            else if (IsReaderSessionPath(path) && http.GetUserId(auth) is { } id)
            {
                var account = await users.GetAsync(id, http.RequestAborted);
                var token = http.GetAccessTokenIdentity(auth);
                // A gone account's token on /auth/guest falls through to a new guest (CreateGuestSession).
                if (account is null && path.StartsWithSegments("/auth/guest"))
                {
                    await next(http);
                    return;
                }
                if (account is null || (token is not null && ResetAfter(account, token.IssuedAt)))
                {
                    http.Response.StatusCode = 401;
                    return;
                }
                http.Items[AccountItemKey] = account;
            }
        }
        catch (NpgsqlException)
        {
            http.Response.StatusCode = 503;
            http.Response.Headers.RetryAfter = "30";
            await http.Response.WriteAsJsonAsync(SyncResult.Unavailable.Body, http.RequestAborted);
            return;
        }
        await next(http);
    }

    private static bool ResetAfter(UserAccount account, DateTimeOffset issuedAt) => account.CredentialsResetAt > issuedAt;

    private static bool IsReaderSessionPath(PathString path) => path.StartsWithSegments("/me")
        || path.StartsWithSegments("/auth/me")
        || path.StartsWithSegments("/auth/guest")
        || path.StartsWithSegments("/auth/device/approve") || path.StartsWithSegments("/auth/device/deny")
        || path.StartsWithSegments("/oauth/authorize/approve") || path.StartsWithSegments("/oauth/authorize/deny")
        || path.StartsWithSegments("/oauth/token-status");

    private static bool IsAdminSessionPath(PathString path) => path.StartsWithSegments("/admin")
        && !path.StartsWithSegments("/admin/auth/login") && !path.StartsWithSegments("/admin/auth/refresh")
        && !path.StartsWithSegments("/admin/auth/logout");
}
