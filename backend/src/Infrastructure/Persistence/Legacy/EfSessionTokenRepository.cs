using Application.Common.Interfaces;
using Application.Identity;
using Domain.Identity;
using Microsoft.EntityFrameworkCore;

namespace Infrastructure.Persistence.Legacy;

/// <summary>
/// <see cref="ISessionTokenRepository"/> on the legacy database (#1100): <c>RetentionCleanupWorker</c>'s
/// sweeps. Legacy sessions have no families, so an expired one goes on its own expiry; reader and
/// admin sessions are two tables there, swept together as V2's one table is. Issuing, rotating and
/// resetting are legacy <c>AuthService</c>'s (<see cref="LegacySignIn"/>).
/// </summary>
public sealed class EfSessionTokenRepository(IAppDbContext db) : ISessionTokenRepository
{
    public async Task<int> DeleteExpiredSessionsAsync(DateTimeOffset expiredBefore, CancellationToken ct) =>
        await db.UserRefreshTokens.Where(t => t.ExpiresAt < expiredBefore).ExecuteDeleteAsync(ct)
        + await db.AdminRefreshTokens.Where(t => t.ExpiresAt < expiredBefore).ExecuteDeleteAsync(ct);

    public Task<int> DeleteExpiredPasswordResetsAsync(DateTimeOffset expiredBefore, CancellationToken ct) =>
        db.PasswordResetTokens.Where(t => t.ExpiresAt < expiredBefore).ExecuteDeleteAsync(ct);

    public Task<SessionToken?> IssueAsync(
        Guid userId, string tokenHash, DateTimeOffset expiresAt, string? verifiedPasswordHash, DateTimeOffset? tokenIssuedAt, SessionKind kind, CancellationToken ct) =>
        throw LegacySignIn.Owns();

    public Task<SessionRefresh> RefreshAsync(
        string oldTokenHash, string newTokenHash, SessionKind kind, Func<UserAccount, DateTimeOffset> expiresAt, DateTimeOffset now, CancellationToken ct) =>
        throw LegacySignIn.Owns();

    public Task<bool> RevokeAsync(string tokenHash, SessionKind kind, CancellationToken ct) => throw LegacySignIn.Owns();

    public Task<PasswordReset> CreatePasswordResetAsync(Guid userId, string tokenHash, DateTimeOffset expiresAt, CancellationToken ct) => throw LegacySignIn.Owns();

    public Task<Guid?> ResetPasswordAsync(string tokenHash, string passwordHash, DateTimeOffset now, CancellationToken ct) => throw LegacySignIn.Owns();
}
