namespace Api.Extensions;

/// <summary>
/// The rate-limiter values that are not compiled in. Bound from the <c>RateLimits</c> section
/// (env: <c>RateLimits__GuestSessionPermitLimit</c>), mirroring <c>JwtSettings</c>.
/// </summary>
/// <remarks>
/// Only knobs that a deployment genuinely has to move live here — everything else stays a literal
/// in <c>AddTextStackRateLimiting</c>, where it is readable next to the comment explaining it.
/// </remarks>
public sealed class RateLimitSettings
{
    public const string SectionName = "RateLimits";

    /// <summary>Guest-session creates allowed per IP per 5-minute window. Production default is 3.</summary>
    /// <remarks>
    /// CI raises this via compose env because the guest-merge integration suite needs ≥6 guests and
    /// every request in CI comes from one host. Deliberately NOT a test-only bypass: the limiter must
    /// be on the same code path in CI as in production, or a regression in the limiter itself would
    /// never fail a test.
    /// </remarks>
    public int GuestSessionPermitLimit { get; set; } = DefaultGuestSessionPermitLimit;

    public const int DefaultGuestSessionPermitLimit = 3;

    /// <summary>A configured 0 or negative is a typo, and locking every client out of guest sessions
    /// is an outage — degrade to the production default instead of to zero.</summary>
    public int EffectiveGuestSessionPermitLimit =>
        GuestSessionPermitLimit > 0 ? GuestSessionPermitLimit : DefaultGuestSessionPermitLimit;

    // The three knobs below exist only because the limiter started being reached (UseRateLimiter
    // moved below UseRouting). Until then no per-endpoint policy ran, so no production value here
    // could throttle anything, including the integration suite. They belong with that change, not
    // with the guest-session knob above, which was needed even while the limiter was inert.

    /// <summary>Register / login / forgot-password / reset-password attempts allowed per IP per
    /// minute. Production default is 10.</summary>
    /// <remarks>
    /// Configurable for the same reason as the guest limit, and it became necessary the moment the
    /// limiter started running: the guest-merge suite drives ~15 register+login calls from one host
    /// inside a minute, so at the production value it would rate-limit itself into skips — a green
    /// CI with zero merge coverage, which is the exact failure this PR is trying to stop happening.
    /// </remarks>
    public int UserLoginPermitLimit { get; set; } = DefaultUserLoginPermitLimit;

    public const int DefaultUserLoginPermitLimit = 10;

    /// <inheritdoc cref="EffectiveGuestSessionPermitLimit"/>
    public int EffectiveUserLoginPermitLimit => Effective(UserLoginPermitLimit, DefaultUserLoginPermitLimit);

    /// <summary>Web-clip / "send to TextStack" receives allowed per IP per minute. Production
    /// default is 20.</summary>
    /// <remarks>
    /// The integration suite seeds a user book by clipping one, in a dozen different test classes,
    /// so a single run makes well over twenty clips from one host. At the production value most of
    /// those classes skip on "clip seed unavailable" — silently, and across user-books, highlights,
    /// reading-sessions and RAG coverage at once.
    /// </remarks>
    public int ClipPermitLimit { get; set; } = DefaultClipPermitLimit;

    public const int DefaultClipPermitLimit = 20;

    /// <inheritdoc cref="EffectiveGuestSessionPermitLimit"/>
    public int EffectiveClipPermitLimit => Effective(ClipPermitLimit, DefaultClipPermitLimit);

    /// <summary>Account hard-deletes allowed per IP per 5 minutes. Production default is 3.</summary>
    /// <remarks>
    /// A person never needs more than one, which is why the production number is tiny — but the GDPR
    /// delete suite legitimately calls it four times in one test class (unauthenticated probe, the
    /// delete, the repeat-delete that must be a clean 401, and the cleanup of the re-created user).
    /// </remarks>
    public int AccountDeletePermitLimit { get; set; } = DefaultAccountDeletePermitLimit;

    public const int DefaultAccountDeletePermitLimit = 3;

    /// <inheritdoc cref="EffectiveGuestSessionPermitLimit"/>
    public int EffectiveAccountDeletePermitLimit =>
        Effective(AccountDeletePermitLimit, DefaultAccountDeletePermitLimit);

    /// <summary>Shared normalization: a configured 0 or negative is a typo, and a zero permit limit
    /// is an outage, so it degrades to the production default rather than to a lockout.</summary>
    private static int Effective(int configured, int productionDefault) =>
        configured > 0 ? configured : productionDefault;
}
