using Domain.Identity;

namespace Application.Identity;

/// <summary>
/// The V2 device-flow logins (RFC 8628; table <c>device_authorizations</c>). Kept apart from
/// <see cref="IOAuthRepository"/>: it is the CLI's sign-in, not the MCP OAuth server, and one
/// repository holding both would pass the size rule 13 sets. A login is found by its device code
/// (hashed) or its user code; it belongs to a user only once approved.
/// </summary>
public interface IDeviceLoginRepository
{
    Task CreateAsync(DeviceLogin login, CancellationToken ct);

    /// <summary>Whether a pending login alive at <paramref name="now"/> already shows this user code.</summary>
    Task<bool> PendingUserCodeExistsAsync(string userCode, DateTimeOffset now, CancellationToken ct);

    /// <summary>
    /// Decides the pending login showing <paramref name="userCode"/>: approves it for
    /// <paramref name="approvedBy"/>, or denies it when that is null. A login past its deadline at
    /// <paramref name="now"/> is marked expired instead. Returns the status it now has; null when no
    /// pending login shows that code.
    /// </summary>
    Task<string?> DecideAsync(string userCode, Guid? approvedBy, DateTimeOffset now, CancellationToken ct);

    /// <summary>The login polled with this device code; null when none.</summary>
    Task<DeviceLogin?> GetByDeviceCodeAsync(string deviceCodeHash, CancellationToken ct);

    /// <summary>Marks a pending login expired (its deadline passed while the device polled). False when it was not pending.</summary>
    Task<bool> ExpireAsync(Guid loginId, CancellationToken ct);

    /// <summary>
    /// Redeems an approved login, once: it becomes expired and consumed, so a second redemption cannot
    /// mint another session. Returns the user it was approved for; null when it was not approved, or
    /// its deadline passed by <paramref name="now"/> (the sweep deletes it only a day later).
    /// </summary>
    Task<Guid?> RedeemAsync(Guid loginId, DateTimeOffset now, CancellationToken ct);

    /// <summary>Deletes logins that expired before <paramref name="expiredBefore"/>; returns how many.</summary>
    Task<int> DeleteExpiredAsync(DateTimeOffset expiredBefore, CancellationToken ct);
}
