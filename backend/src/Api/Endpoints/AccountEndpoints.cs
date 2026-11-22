using Api.Extensions;
using Api.Sync;
using Application.Auth;

namespace Api.Endpoints;

/// <summary>
/// Account-level operations for the currently authenticated user.
/// Hosts the GDPR / Google-Play "delete my account + all data" hard delete.
/// </summary>
public static class AccountEndpoints
{
    public static void MapAccountEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/me/account").WithTags("Account").RejectOAuthTokens();

        group.MapDelete("/", DeleteAccount)
            .WithName("DeleteAccount")
            .RequireRateLimiting("account-delete");
    }

    /// <summary>
    /// Hard-deletes the authenticated user and ALL data linked to them
    /// (<see cref="IAuthService.DeleteAccountAsync"/>).
    /// </summary>
    private static async Task<IResult> DeleteAccount(
        HttpContext httpContext,
        IAuthService authService,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null || !await authService.DeleteAccountAsync(userId.Value, ct)) return Results.Unauthorized();
        return Results.NoContent();
    }
}
