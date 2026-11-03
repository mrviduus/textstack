using Application.Auth;
using Application.Common.Interfaces;
using Application.Identity;
using Domain.Identity;
using Microsoft.EntityFrameworkCore;

namespace Infrastructure.Persistence.Legacy;

/// <summary>
/// <see cref="IUserRepository"/> on the legacy <c>users</c> table (#1100): the profile edits of
/// <c>ProfileEndpoints</c> and the activity stamp of <c>GuestActivityMiddleware</c>. The rest is
/// legacy <c>AuthService</c>'s (<see cref="LegacySignIn"/>).
/// </summary>
public sealed class EfUserRepository(IAppDbContext db) : IUserRepository
{
    public async Task<UserAccount?> UpdateNameAndLanguageAsync(Guid userId, string? name, string? nativeLanguage, CancellationToken ct) =>
        await db.Users.Where(u => u.Id == userId)
            .ExecuteUpdateAsync(s => s.SetProperty(u => u.Name, name).SetProperty(u => u.NativeLanguage, nativeLanguage), ct) == 0
            ? null
            : await ReadAsync(userId, ct);

    public async Task<UserAccount?> SetPictureAsync(Guid userId, string? picture, CancellationToken ct) =>
        await db.Users.Where(u => u.Id == userId).ExecuteUpdateAsync(s => s.SetProperty(u => u.Picture, picture), ct) == 0
            ? null
            : await ReadAsync(userId, ct);

    public async Task<bool> TouchActiveAsync(Guid userId, DateTimeOffset now, CancellationToken ct) =>
        await db.Users.Where(u => u.Id == userId).ExecuteUpdateAsync(s => s.SetProperty(u => u.LastActiveAt, now), ct) > 0;

    // Untracked: the request may hold the row tracked from before the update, and a tracked read
    // would answer with that stale copy.
    private async Task<UserAccount?> ReadAsync(Guid userId, CancellationToken ct) =>
        await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Id == userId, ct) is { } user ? AuthService.ToAccount(user) : null;

    public Task<UserAccount?> GetAsync(Guid userId, CancellationToken ct) => throw LegacySignIn.Owns();

    public Task<UserAccount?> GetByEmailAsync(string email, CancellationToken ct) => throw LegacySignIn.Owns();

    public Task<UserAccount?> GetByGoogleSubjectAsync(string googleSubject, CancellationToken ct) => throw LegacySignIn.Owns();

    public Task<UserAccount?> GetByAppleSubjectAsync(string appleSubject, CancellationToken ct) => throw LegacySignIn.Owns();

    public Task<UserAccount?> CreateAsync(UserAccount account, CancellationToken ct) => throw LegacySignIn.Owns();

    public Task<AccountUpdate> UpdateProfileAsync(Guid userId, string email, string? name, string? picture, CancellationToken ct) => throw LegacySignIn.Owns();

    public Task<AccountUpdate> PromoteGuestAsync(Guid userId, string email, string? name, string passwordHash, CancellationToken ct) => throw LegacySignIn.Owns();

    public Task<bool> SetRoleAsync(Guid userId, string role, CancellationToken ct) => throw LegacySignIn.Owns();

    public Task<bool> DeleteAsync(Guid userId, CancellationToken ct) => throw LegacySignIn.Owns();

    // Legacy's own filter is GuestCleanupWorker's query; only V2's answer is asked.
    public Task<bool> HoldsNothingDurableAsync(Guid userId, CancellationToken ct) => throw LegacySignIn.Owns();
}
