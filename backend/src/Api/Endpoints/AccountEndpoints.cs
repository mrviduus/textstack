using Api.Extensions;
using Application.Auth;
using Application.Common.Interfaces;
using Microsoft.EntityFrameworkCore;

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
    /// Hard-deletes the authenticated user and ALL data linked to them.
    ///
    /// Strategy: every user-owned entity has a configured FK to <c>users</c>.
    /// Owned data (library, progress, bookmarks, notes, highlights, reading
    /// sessions / goals / achievements, vocabulary words+reviews+settings+
    /// pending+lookups+clusters, user books → chapters/files/ingestion jobs/
    /// bookmarks/chunks/quality jobs, collections → book-collections, refresh
    /// tokens, password-reset tokens) is configured ON DELETE CASCADE, so a
    /// single <c>Users.Remove</c> + SaveChanges removes it all in FK-safe order.
    /// Audit rows (llm_traces, shadow_runs, agent_run, device_authorizations)
    /// are ON DELETE SET NULL — their user_id is nulled, preserving the trace
    /// while removing the personal link.
    ///
    /// Wrapped in a transaction so it is all-or-nothing. Disk files (avatar +
    /// uploaded book files) are not in the DB, so they are removed via the
    /// storage service AFTER the DB commit (DB is the source of truth; an orphan
    /// file is recoverable, an orphan row is a compliance failure).
    /// </summary>
    private static async Task<IResult> DeleteAccount(
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        IFileStorageService storage,
        ILogger<Program> logger,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == userId.Value, ct);
        if (user == null) return Results.Unauthorized();

        // Capture disk locations before the row is gone. Local-file avatar only
        // (external picture URLs like Google are not ours to delete).
        var avatarPath = !string.IsNullOrEmpty(user.Picture) && !user.Picture.StartsWith("http")
            ? user.Picture
            : null;

        await using var tx = await db.BeginTransactionAsync(ct);

        db.Users.Remove(user);
        await db.SaveChangesAsync(ct);

        await tx.CommitAsync(ct);

        // Best-effort disk cleanup post-commit. Removes the whole
        // users/{shard}/{userId} tree (all uploaded book files) + the avatar.
        // Failures here must not resurrect the account (DB is the source of truth),
        // so they are logged as warnings instead of failing the request — an orphan
        // file is recoverable, but it must be observable.
        try
        {
            await storage.DeleteUserDirectoryAsync(user.Id, ct);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex,
                "Account {UserId} deleted but storage cleanup failed for {Operation}",
                userId.Value, "DeleteUserDirectory");
        }

        if (avatarPath != null)
        {
            try
            {
                await storage.DeleteFileAsync(avatarPath, ct);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex,
                    "Account {UserId} deleted but storage cleanup failed for {Operation} ({Path})",
                    userId.Value, "DeleteAvatar", avatarPath);
            }
        }

        return Results.NoContent();
    }
}
