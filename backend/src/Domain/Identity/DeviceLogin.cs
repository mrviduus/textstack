namespace Domain.Identity;

/// <summary>
/// A device-flow login attempt (V2 table <c>device_authorizations</c>, RFC 8628): the device polls
/// with the code it holds (stored hashed) while the user types <see cref="UserCode"/> on a signed-in
/// page and approves or denies it.
/// </summary>
public class DeviceLogin
{
    public const string Pending = "pending";
    public const string Approved = "approved";
    public const string Denied = "denied";

    /// <summary>Also the status of a redeemed login, so it can never mint a session again.</summary>
    public const string Expired = "expired";

    public Guid Id { get; set; }
    public string DeviceCodeHash { get; set; } = "";
    public string UserCode { get; set; } = "";

    /// <summary>Who approved it; null until then.</summary>
    public Guid? UserId { get; set; }

    /// <summary><see cref="Pending"/>, <see cref="Approved"/>, <see cref="Denied"/> or <see cref="Expired"/>.</summary>
    public string Status { get; set; } = Pending;

    public DateTimeOffset ExpiresAt { get; set; }
    public int IntervalSeconds { get; set; }
    public DateTimeOffset? ConsumedAt { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}
