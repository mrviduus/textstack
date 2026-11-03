using Domain.Identity;

namespace Application.Identity;

/// <summary>
/// The V2 device-flow logins (RFC 8628; table <c>device_authorizations</c>): the CLI's sign-in. A
/// login is found by its device code (hashed) or its user code; it belongs to a user only once approved.
/// </summary>
public interface IDeviceLoginRepository
{
    /// <summary>
    /// Stores a pending login. False when a pending login already shows its user code (one past its
    /// deadline too, until it is decided or swept): nothing stored, the caller mints another code.
    /// </summary>
    Task<bool> CreateAsync(DeviceLogin login, CancellationToken ct);

    /// <summary>
    /// Decides the pending login showing <paramref name="userCode"/>: approves it for
    /// <paramref name="approvedBy"/>, or denies it when that is null. A login past its deadline at
    /// <paramref name="now"/> is marked expired instead. Returns the status it now has; null when no
    /// pending login shows that code. <see cref="DeviceLogin.Pending"/> when the approver's password
    /// was reset after <paramref name="tokenIssuedAt"/> (the <c>iat</c> of the access token approving;
    /// null for a denial) or the approver is gone: nothing decided.
    /// </summary>
    Task<string?> DecideAsync(string userCode, Guid? approvedBy, DateTimeOffset? tokenIssuedAt, DateTimeOffset now, CancellationToken ct);

    /// <summary>The login polled with this device code; null when none.</summary>
    Task<DeviceLogin?> GetByDeviceCodeAsync(string deviceCodeHash, CancellationToken ct);

    /// <summary>
    /// Redeems an approved login, once, and stores the reader session it mints for its approver
    /// (<paramref name="tokenHash"/>, live until <paramref name="sessionExpiresAt"/>) together: the login
    /// becomes expired and consumed, so a second redemption cannot mint another. False (nothing stored)
    /// when it was not approved, or its deadline passed by <paramref name="now"/>. A password reset of
    /// the approver never leaves the session behind.
    /// </summary>
    Task<bool> RedeemAsync(Guid loginId, string tokenHash, DateTimeOffset sessionExpiresAt, DateTimeOffset now, CancellationToken ct);

    /// <summary>Deletes logins that expired before <paramref name="expiredBefore"/>; returns how many.</summary>
    Task<int> DeleteExpiredAsync(DateTimeOffset expiredBefore, CancellationToken ct);
}
