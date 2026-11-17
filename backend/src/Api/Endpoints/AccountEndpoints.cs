using Api.Extensions;
using Api.V2;
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
    /// (<see cref="IAuthService.DeleteAccountAsync"/>); then V2 follows the committed delete when
    /// Features:V2Api is on, never failing this request.
    /// </summary>
    private static async Task<IResult> DeleteAccount(
        HttpContext httpContext,
        IAuthService authService,
        V2IdentityMirror mirror,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null || !await authService.DeleteAccountAsync(userId.Value, ct)) return Results.Unauthorized();

        await mirror.DeleteAsync(userId.Value);
        return Results.NoContent();
    }
}
