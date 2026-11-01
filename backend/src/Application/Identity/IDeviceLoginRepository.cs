using Domain.Identity;

namespace Application.Identity;

/// <summary>
/// The V2 device-flow logins (RFC 8628; table <c>device_authorizations</c>): the CLI's sign-in. A
/// login is found by its device code (hashed) or its user code; it belongs to a user only once approved.
/// </summary>
public interface IDeviceLoginRepository
{
    /// <summary>
    /// Stores a pending login. False when a pending login alive at <paramref name="now"/> already shows
    /// its user code: nothing stored, the caller mints another code.
    /// </summary>
    Task<bool> CreateAsync(DeviceLogin login, DateTimeOffset now, CancellationToken ct);

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
    /// its deadline passed by <paramref name="now"/>.
    /// </summary>
    Task<Guid?> RedeemAsync(Guid loginId, DateTimeOffset now, CancellationToken ct);

    /// <summary>Deletes logins that expired before <paramref name="expiredBefore"/>; returns how many.</summary>
    Task<int> DeleteExpiredAsync(DateTimeOffset expiredBefore, CancellationToken ct);
}
