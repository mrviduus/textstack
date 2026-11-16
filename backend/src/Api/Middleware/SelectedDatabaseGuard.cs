using Api.Extensions;
using Api.V2;
using Application.AdminAuth;
using Application.Auth;
using Application.Identity;
using Application.Sync;
using Domain.Identity;
using Infrastructure.Persistence;
using Npgsql;

namespace Api.Middleware;

/// <summary>V2 mode never falls back to legacy user handlers or accepts a reset/deleted account's JWT.</summary>
public sealed class SelectedDatabaseGuard(RequestDelegate next, DatabaseMode mode)
{
    public static readonly object AccountItemKey = new();

    public async Task InvokeAsync(HttpContext http, IAuthService auth, IUserRepository users)
    {
        if (!mode.IsV2 || HttpMethods.IsOptions(http.Request.Method))
        {
            await next(http);
            return;
        }

        var endpoint = http.GetEndpoint();
        var path = http.Request.Path;
        var privatePath = path.StartsWithSegments("/me") || path.StartsWithSegments("/admin");
        var mutation = !HttpMethods.IsGet(http.Request.Method) && !HttpMethods.IsHead(http.Request.Method);
        if (endpoint is not null && (privatePath || mutation)
            && endpoint.Metadata.GetMetadata<V2SelectedRoute>() is null)
        {
            // Part C must adapt or deliberately retire this route before cutover; never write the wrong database.
            http.Response.StatusCode = 503;
            http.Response.Headers.RetryAfter = "60";
            if (path.StartsWithSegments("/me/v2"))
                await http.Response.WriteAsJsonAsync(SyncResult.V2Unavailable.Body, http.RequestAborted);
            else
                await http.Response.WriteAsJsonAsync(new { error = "v2_compatibility_pending" }, http.RequestAborted);
            return;
        }

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
            await http.Response.WriteAsJsonAsync(SyncResult.V2Unavailable.Body, http.RequestAborted);
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
