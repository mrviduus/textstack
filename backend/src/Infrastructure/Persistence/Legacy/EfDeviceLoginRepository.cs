using Application.Common.Interfaces;
using Application.Identity;
using Domain.Identity;
using Microsoft.EntityFrameworkCore;

namespace Infrastructure.Persistence.Legacy;

/// <summary>
/// <see cref="IDeviceLoginRepository"/> on the legacy database (#1100): <c>RetentionCleanupWorker</c>'s
/// sweep. The device flow itself is legacy <c>AuthService</c>'s (<see cref="LegacySignIn"/>).
/// </summary>
public sealed class EfDeviceLoginRepository(IAppDbContext db) : IDeviceLoginRepository
{
    public Task<int> DeleteExpiredAsync(DateTimeOffset expiredBefore, CancellationToken ct) =>
        db.DeviceAuthorizations.Where(d => d.ExpiresAt < expiredBefore).ExecuteDeleteAsync(ct);

    public Task<bool> CreateAsync(DeviceLogin login, CancellationToken ct) => throw LegacySignIn.Owns();

    public Task<string?> DecideAsync(string userCode, Guid? approvedBy, DateTimeOffset? tokenIssuedAt, DateTimeOffset now, CancellationToken ct) =>
        throw LegacySignIn.Owns();

    public Task<DeviceLogin?> GetByDeviceCodeAsync(string deviceCodeHash, CancellationToken ct) => throw LegacySignIn.Owns();

    public Task<bool> RedeemAsync(Guid loginId, string tokenHash, DateTimeOffset sessionExpiresAt, DateTimeOffset now, CancellationToken ct) =>
        throw LegacySignIn.Owns();
}
